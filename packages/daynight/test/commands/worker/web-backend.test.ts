import { performance } from "node:perf_hooks";
import { CLEANUP_OPERATION_MS } from "../../../src/commands/cleanup-operation.js";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createWorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import { PromptInputLimitError } from "../../../src/commands/worker/prompt-input-limit.js";
import type { WorkerPromptTuple } from "../../../src/commands/worker/prompt-source.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as launchTickets from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { requestController } from "../../../src/commands/controller/local-client.js";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";

const { fixture, cleanupSource, orchestrationFixture, recoveryFixture } = createWebBackendFixtures("memory");

it("waits for new Web prompts and retries only after a rejected revision changes", async () => {
  const f = await fixture();
  const input = f.store.getTask(f.identity)!;
  const resource = (scope: "user" | "project" | "worker", revision: string, text: string) => ({ scope, scopeId: randomUUID(), revision, text, updatedAt: new Date(0).toISOString() });
  const tuple = (revision: string): WorkerPromptTuple => ({ user: resource("user", revision, "personal"), project: resource("project", "1", "project"), worker: resource("worker", "1", "worker") });
  let value: WorkerPromptTuple | null = null;
  const promptSource = { current: vi.fn(() => value) };
  const captured: string[] = [];
  const launcher = {
    prepare: vi.fn(async (_task: LocalTask, prompt: string | (() => string)): Promise<ControllerLaunchTicket> => {
      value = tuple(value!.user.revision === "1" ? "2" : value!.user.revision);
      captured.push(typeof prompt === "function" ? prompt() : prompt);
      throw new PromptInputLimitError("web_ticket", 7, 6);
    }), launch: vi.fn(), refreshGrant: vi.fn(),
  };
  const emit = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "linux", buildPrompt: () => "builtin", promptSource, emit, now: () => 10 });
  const signal = new AbortController().signal;
  expect(await backend.advanceResult(input, signal)).toMatchObject({ kind: "waiting_input", reason: "prompt_unknown" });
  expect(launcher.prepare).not.toHaveBeenCalled();
  value = tuple("1");
  expect(await backend.advanceResult(input, signal)).toMatchObject({ kind: "waiting_input", reason: "prompt_too_large" });
  expect(captured[0]).toContain("----- begin user prompt -----\npersonal");
  expect(emit).toHaveBeenCalledOnce();
  await backend.advanceResult(input, signal);
  expect(launcher.prepare).toHaveBeenCalledOnce();
  value = tuple("3");
  expect(await backend.advanceResult(input, signal)).toMatchObject({ kind: "waiting_input", reason: "prompt_too_large" });
  expect(launcher.prepare).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenCalledTimes(2);
  expect(launcher.launch).not.toHaveBeenCalled();
  expect(f.store.getTask(input)).toMatchObject({ recovery: { count: 0, pauseReason: null }, webExecution: { initialPrompt: null, launchSubmission: "not-submitted" } });
});

it("revalidates a worktree obstruction without native recovery, launch, or initial input replay", async () => {
  const f = await orchestrationFixture();
  const { WorktreePreconditionError } = await import("../../../src/commands/worker/worktrees.js");
  vi.mocked(f.git.verifyWorktree).mockRejectedValue(new WorktreePreconditionError("branch_mismatch", "The task worktree no longer uses its original task branch."));
  for (let i = 0; i < 4; i++) await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow("original task branch");
  expect(f.store.getTask(f.task)?.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
  expect(f.store.getOrchestrationBlocker(f.task)).toMatchObject({ source: "worktree", code: "branch_mismatch" });
  vi.mocked(f.git.verifyWorktree).mockResolvedValue(f.task.resources.worktree!);
  const recovered = await f.backend.advance(f.task, new AbortController().signal);
  expect(f.store.getOrchestrationBlocker(f.task)).toBeNull();
  expect(recovered.webExecution).toMatchObject({ executionGeneration: "1", controllerInstanceId: f.task.webExecution!.controllerInstanceId });
  expect(recovered.webExecution!.startupReport!.revision).toBe("2");
  expect(recovered.recovery.count).toBe(0);
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
  expect(f.source.request.mock.calls.map(call => call[1].kind)).toEqual(["observe"]);
});

it.each((["not_submitted", "dispatching", "provider_accepted", "unknown", "confirmed"] as const).flatMap(delivery => [false, true].map(bound => [delivery, bound] as const)))("continues the first starting generation without replaying %s delivery (native bound=%s)", async (delivery, bound) => {
  const f = await fixture("codex", 3);
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  if (bound) task = f.store.bindNativeSession(task, { source: "controller", sessionId: randomUUID() }, 3);
  const source = await cleanupSource(f, task);
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "original-native", commandHash: "b".repeat(64) };
  let snapshot: ControllerSnapshot = { ...source.snapshot, lifecycle: "starting", nativeStopped: false, stoppedAt: null, initialInputState: "not_submitted", startup: { state: "starting", reasonCode: "initializing" }, nativeProcesses: [] };
  source.saved.mockImplementation(() => snapshot);
  source.request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "submit_initial") { expect(action.operationId).toBe(source.ticket.initialOperationId); snapshot = { ...snapshot, initialInputState: "unknown" }; }
    return { requestId: randomUUID(), ok: true, snapshot };
  });
  source.stopped.mockResolvedValue(false); vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("running");
  const launcher = { prepare: vi.fn(async () => source.ticket), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50_000, request: source.request });
  const starting = await backend.advance(source.task, new AbortController().signal);
  expect(starting.resources.nativeSession !== null).toBe(bound);
  expect(starting.webExecution?.initialInputState).toBe("not_submitted");
  vi.mocked(f.git.verifyWorktree).mockRejectedValueOnce(new Error("Temporary branch deviation."));
  await expect(backend.advance(starting, new AbortController().signal)).rejects.toThrow("Temporary branch");
  snapshot = { ...snapshot, lifecycle: "ready", activity: "idle", startup: { state: "ready", reasonCode: "ready" }, nativeSessionId: starting.resources.nativeSession?.sessionId ?? randomUUID(), initialInputState: delivery, nativeProcesses: [native] };
  launcher.prepare.mockClear(); launcher.launch.mockClear(); source.request.mockClear();
  const ready = await backend.advance(starting, new AbortController().signal);
  expect(ready.resources.nativeSession?.sessionId).toBe(snapshot.nativeSessionId);
  expect(ready.webExecution?.executionGeneration).toBe("1");
  expect(ready.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
  expect(f.store.getOrchestrationBlocker(ready)).toBeNull();
  expect(source.request.mock.calls.map(([, action]) => action.kind)).toEqual(delivery === "not_submitted" ? ["observe", "submit_initial"] : ["observe"]);
  expect(launcher.prepare).not.toHaveBeenCalled(); expect(launcher.launch).not.toHaveBeenCalled();
  await backend.advance(ready, new AbortController().signal);
  expect(source.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(delivery === "not_submitted" ? 1 : 0);
});

it.each([false, true])("preserves earlier process proofs when first-generation startup appends native processes (worker proof=%s)", async workerProof => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  const first = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "original-native", commandHash: "b".repeat(64) };
  const second = { ...first, pid: 989, startedAt: "second-native" };
  if (workerProof) f.store.updateWebExecution(source.task, { nativeProcesses: [first] }, 7);
  const saved: ControllerSnapshot = { ...source.snapshot, lifecycle: "starting", nativeStopped: false, stoppedAt: null, initialInputState: "not_submitted", startup: { state: "starting", reasonCode: "initializing" }, nativeSessionId: randomUUID(), nativeProcesses: [first] };
  const observed: ControllerSnapshot = { ...saved, lifecycle: "ready", activity: "idle", startup: { state: "ready", reasonCode: "ready" }, initialInputState: "confirmed", nativeProcesses: [first, second] };
  f.store.blockOrchestration(source.task, { source: "worktree", code: "branch_mismatch", message: "Branch differs." }, 8);
  source.saved.mockReturnValue(saved); source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot: observed });
  source.stopped.mockResolvedValue(false);
  const inspect = vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("running");
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50_000, request: source.request });
  const result = await backend.advance(source.task, new AbortController().signal);
  expect(result.webExecution?.nativeProcesses).toEqual([first, second]);
  expect(result.resources.nativeSession?.sessionId).toBe(saved.nativeSessionId);
  expect(result.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
  expect(f.store.getOrchestrationBlocker(task)).toBeNull();
  expect(inspect.mock.calls.map(([proof]) => proof)).toEqual([saved.controllerProcess, first, second]);
  expect(source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
  expect(launcher.launch).not.toHaveBeenCalled();
});

it.each(["journal-native", "journal-process", "journal-delivery", "unknown-delivery", "legacy"] as const)("rejects a first-generation continuation with conflicting %s evidence", async conflict => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "original-native", commandHash: "b".repeat(64) };
  const saved: ControllerSnapshot = { ...source.snapshot, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, error: null, initialInputState: "not_submitted", startup: { state: "ready", reasonCode: "ready" }, nativeSessionId: randomUUID(), nativeProcesses: [native] };
  const observed = { ...saved };
  if (conflict === "journal-native") observed.nativeSessionId = randomUUID();
  if (conflict === "journal-process") observed.nativeProcesses = [{ ...native, pid: 989 }];
  if (conflict === "journal-delivery") saved.initialInputState = "unknown";
  if (conflict === "unknown-delivery") f.store.updateWebExecution(source.task, { initialInputState: "unknown" }, 7);
  f.store.blockOrchestration(source.task, { source: conflict === "legacy" ? "legacy_worktree" : "worktree", code: "branch_mismatch", message: "Branch differs." }, 8);
  source.saved.mockReturnValue(saved); source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot: observed });
  source.stopped.mockResolvedValue(false); vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("running");
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50_000, request: source.request });
  await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow();
  expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
  expect(f.store.getOrchestrationBlocker(task)).not.toBeNull();
  expect(source.request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
  expect(launcher.launch).not.toHaveBeenCalled();
});

it.each((["paused", "failed", "stopped", "stopping"] as const).flatMap(lifecycle => [false, true].map(blocked => [lifecycle, blocked] as const)))("preserves real native %s protection below the recovery budget (worktree blocked=%s)", async (lifecycleState, blocked) => {
  const f = await orchestrationFixture();
  if (blocked) f.store.blockOrchestration(f.task, { source: "worktree", code: "branch_mismatch", message: "Branch differs." }, 8);
  f.source.stopped.mockResolvedValue(false);
  f.launcher.prepare.mockResolvedValue(f.source.ticket);
  f.source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, lifecycle: lifecycleState, error: "Original native lifecycle failed." } });
  await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow();
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 0, pauseReason: "Original native lifecycle failed.", retryAuthorized: false });
  expect(f.backend.observeStartupReport(f.task)?.recovery).toEqual({ state: "blocked", reasonCode: "recovery_blocked" });
  expect(f.store.getOrchestrationBlocker(f.task) !== null).toBe(blocked);
});

it.each(["native", "generation", "controller", "process", "stopped", "initial"])("retains an orchestration block when the original %s evidence conflicts", async conflict => {
  const f = await orchestrationFixture();
  f.store.blockOrchestration(f.task, { source: "worktree", code: "branch_mismatch", message: "branch mismatch" }, 20_000);
  const snapshot = { ...f.snapshot };
  if (conflict === "native") snapshot.nativeSessionId = randomUUID();
  if (conflict === "generation") snapshot.executionGeneration = "2";
  if (conflict === "controller") snapshot.controllerInstanceId = randomUUID();
  if (conflict === "stopped") snapshot.nativeStopped = true;
  if (conflict === "initial") snapshot.initialInputState = "not_submitted";
  if (conflict === "process") vi.mocked(processProof.inspectProcessProof).mockResolvedValue("replaced");
  f.source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot });
  await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow();
  expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
  expect(f.store.getTask(f.task)?.recovery.count).toBe(0);
  expect(f.launcher.launch).not.toHaveBeenCalled();
});

it.each([true, false])("corrects only a legacy branch latch with matching diagnostic provenance (logs=%s)", async logs => {
  const f = await orchestrationFixture();
  f.store.pauseRecovery(f.task, "The task worktree no longer uses its original task branch.", 20_000, "recovery_limit");
  const report = f.store.observeStartup(f.task, { state: "ready", reasonCode: "ready" }, 20_000)!;
  if (logs) {
    const dir = path.join(f.home, ".daynight", "worker", "logs"); await mkdir(dir, { recursive: true });
    const entries = [1_000, 6_000, 12_000, 20_100].map(timestamp => ({ timestamp: new Date(timestamp).toISOString(), workerId: f.task.workerId, projectId: f.task.projectId, taskId: f.task.taskId, claimId: f.task.claimId, sessionId: f.task.resources.nativeSession!.sessionId, kind: "execution-error", error: { name: "Error", message: "The task worktree no longer uses its original task branch." } }));
    await writeFile(path.join(dir, "worker-1970-01-01.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
  if (logs) {
    const result = await f.backend.advance(f.task, new AbortController().signal);
    expect(result.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
    expect(BigInt(result.webExecution!.startupReport!.revision)).toBeGreaterThan(BigInt(report.revision));
  } else {
    await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow(/provenance/);
    expect(f.store.getTask(f.task)?.recovery.reasonCode).toBe("recovery_limit");
  }
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it.each(["worker", "claim", "native", "short", "time", "reason", "revision"] as const)("retains legacy recovery protection for conflicting %s provenance", async conflict => {
  const f = await orchestrationFixture();
  f.store.pauseRecovery(f.task, "The task worktree no longer uses its original task branch.", 20_000, "recovery_limit");
  f.store.observeStartup(f.task, { state: "ready", reasonCode: "ready" }, 20_000);
  const dir = path.join(f.home, ".daynight", "worker", "logs"); await mkdir(dir, { recursive: true });
  const entries = [1_000, 6_000, 12_000, 20_100].map(timestamp => ({ timestamp: new Date(timestamp).toISOString(), workerId: f.task.workerId, projectId: f.task.projectId, taskId: f.task.taskId, claimId: f.task.claimId, sessionId: f.task.resources.nativeSession!.sessionId, kind: "execution-error", error: { name: "Error", message: "The task worktree no longer uses its original task branch." } }));
  if (conflict === "worker") entries[3]!.workerId = randomUUID();
  if (conflict === "claim") entries[3]!.claimId = randomUUID();
  if (conflict === "native") entries[3]!.sessionId = randomUUID();
  if (conflict === "short") entries.shift();
  if (conflict === "time") entries[3]!.timestamp = new Date(65_001).toISOString();
  if (conflict === "reason") entries[3]!.error.message = "Original controller stopped.";
  if (conflict === "revision") f.source.request.mockImplementation(async () => {
    f.store.observeStartup(f.task, { state: "unknown", reasonCode: "native_transport_unknown" }, 20_200);
    f.store.observeStartup(f.task, { state: "ready", reasonCode: "ready" }, 20_300);
    return { requestId: randomUUID(), ok: true, snapshot: f.snapshot };
  });
  await writeFile(path.join(dir, "worker-1970-01-01.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow(/provenance|revision/);
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 0, reasonCode: "recovery_limit", retryAuthorized: false });
  expect(f.launcher.launch).not.toHaveBeenCalled();
});

it.each([false,true])("submits once and reobserves unknown first input, including a lazy native identity (lazy=%s)",async(lazyIdentity)=>{
 const f=await fixture();let snapshot:ControllerSnapshot;let launches=0;let submissions=0;
 const launcher={
  prepare:vi.fn(async(task:LocalTask,input:string | (()=>string)):Promise<ControllerLaunchTicket>=>{
   const prompt = typeof input === "function" ? input() : input;
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
 expect(result.task.cleanup).toMatchObject({ kind: "terminal", startedAt: 5, deadline: 100 });
 expect(vi.mocked(f.git.removeWorktree).mock.calls[0]?.[1]).toMatchObject({ claimId: f.identity.claimId, worktreeId: f.identity.worktreeId });
 expect(launcher.launch).not.toHaveBeenCalled();
});

it.each([false,true])("only an orderly shutdown can resume at an exhausted recovery budget (shutdown=%s)",async(orderly)=>{
 const f=await fixture();let task=f.store.bindWorktree(f.identity,await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity,{} as never),3);
 task=f.store.initializeWebExecution(task,4);const nativeId=randomUUID();
 task=f.store.updateWebExecution(task,{sessionId:randomUUID(),initialPrompt:"managed",launchSubmission:"acknowledged",controllerProcess:{pid:123,parentPid:1,processGroupId:123,startedAt:"birth",commandHash:"a".repeat(64)}},5);
 task=f.store.bindNativeSession(task,{source:"controller",sessionId:nativeId},6);
 f.store.beginRecovery(task,7);task=f.store.beginRecovery(task,8);
 if(orderly){f.store.beginCleanup(task,{kind:"shutdown",deadline:100},9);task=f.store.clearShutdown(task,13);}
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
  expect(result.task.cleanup).toMatchObject({ startedAt: 101, deadline: 101 });
  expect(result.task.claimId).toBe(f.identity.claimId);
  expect(request).not.toHaveBeenCalled();
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});

it("preserves an existing cleanup deadline and gives an expired first terminal cleanup no new grace period", async () => {
  const f = await fixture(), request = vi.fn<typeof requestController>(); let now = 101;
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => now, request });
  const first = await backend.cleanup(f.store.getTask(f.identity)!, "terminal", 100);
  expect(first.task.cleanup).toMatchObject({ startedAt: 101, deadline: 101 });
  now = 1_000;
  const retry = await backend.cleanup(first.task, "terminal", now + 600_000);
  expect(retry.task.cleanup).toMatchObject({ startedAt: 101, deadline: 101 });
  expect(request).not.toHaveBeenCalled();
  expect(f.git.removeWorktree).toHaveBeenCalledTimes(2);
});

it("retains the stopped task worktree on archive failure and retries without relaunching business work", async () => {
  const f = await fixture();
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never), 3);
  task = f.store.initializeWebExecution(task, 4);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged" }, 5);
  task = f.store.beginCleanup(task, { kind: "terminal", deadline: 10 }, 6);
  const source = await cleanupSource(f, task); task = source.task;

  const archiveError = new Error("archive offline");
  const archive = vi.fn().mockRejectedValueOnce(archiveError).mockResolvedValue(undefined);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const request = vi.fn<typeof requestController>();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request });
  await expect(backend.cleanup(task, "terminal", 30)).rejects.toMatchObject({ stage: "archive", cause: archiveError });
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
  expect(f.store.getTask(task)?.cleanup).toMatchObject({ kind: "terminal", startedAt: 6, deadline: 10 });
  const result = await backend.cleanup(task, "terminal", 30);
  expect(result.complete).toBe(true);
  expect(archive).toHaveBeenCalledTimes(2);
  expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  expect(launcher.launch).not.toHaveBeenCalled(); expect(source.stopped).toHaveBeenCalledTimes(2);
});

it("ordinary shutdown retains history without publishing an ended archive", async () => {
  const f = await fixture(); let task = f.store.initializeWebExecution(f.store.getTask(f.identity)!, 3);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  task = f.store.beginCleanup(task, { kind: "shutdown", deadline: 10 }, 5);
  const source = await cleanupSource(f, task); task = source.task;

  const archive = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request: source.request });
  await backend.cleanup(task, "shutdown", 30);
  expect(archive).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
});

it.each(["codex", "claude", "copilot"] as const)("shuts down a stopped %s execution after failed terminal archival without retrying or losing finalization", async provider => {
  const f = await fixture(provider);
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never), 3);
  task = f.store.initializeWebExecution(task, 4);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged" }, 5);
  task = f.store.beginCleanup(task, { kind: "terminal", deadline: 10 }, 6);
  const source = await cleanupSource(f, task); task = source.task;

  const archive = vi.fn().mockRejectedValue(new Error("archive offline"));
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const request = vi.fn<typeof requestController>();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request });

  await expect(backend.cleanup(task, "terminal", 30)).rejects.toThrow("archive offline");
  const pending = f.store.getTask(task)!;
  expect(pending.cleanup).toMatchObject({ kind: "terminal", startedAt: 6, deadline: 10 });
  const stopped = await backend.cleanup(pending, "shutdown", 20, undefined, true);
  expect(stopped.task.cleanup).toEqual(pending.cleanup);
  expect(f.store.getTask(task)?.cleanup).toEqual(pending.cleanup);
  expect(archive).toHaveBeenCalledOnce();
  expect(f.git.removeWorktree).not.toHaveBeenCalled();

  archive.mockResolvedValue(undefined);
  const completed = await backend.cleanup(stopped.task, "terminal", 30);
  expect(completed.task.cleanup).toMatchObject({ kind: "terminal", startedAt: 6, deadline: 10 });
  expect(archive).toHaveBeenCalledTimes(2);
  expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  expect(launcher.launch).not.toHaveBeenCalled();
  expect(request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
  expect(source.stopped).toHaveBeenCalledTimes(3);
});

it("cleanup propagates a source snapshot read failure before issuing stop or deletion", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const failure = new Error("controller journal read failed");
  source.saved.mockImplementation(() => { throw failure; });
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 6, request: source.request });
  await expect(backend.cleanup(source.task, "shutdown", 100)).rejects.toMatchObject({ stage: "agent-stop", cause: failure });
  expect(source.request).not.toHaveBeenCalled(); expect(source.stopped).not.toHaveBeenCalled();
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
  expect(f.store.getTask(source.task)?.cleanup).toEqual({ kind: "shutdown", startedAt: 6, deadline: 100 });
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

it.each((["automatic", "explicit"] as const).flatMap(mode => [false, true].map(partial => [mode, partial] as const)))("continues an allocated %s recovery after starting before all process proofs exist (partial=%s)", async (mode, partial) => {
  const f = await recoveryFixture(4);
  const input = mode === "explicit" ? f.store.authorizeRecoveryRetry(f.task, 9) : f.task;
  const controller = { ...f.snapshot.controllerProcess!, pid: 124, processGroupId: 124, startedAt: "replacement-controller" };
  const first = { ...controller, pid: 125, parentPid: 124, startedAt: "replacement-native" };
  const second = { ...first, pid: 126, startedAt: "second-native" };
  let observed!: ControllerSnapshot;
  if (mode === "automatic") f.request.mockRejectedValueOnce(new Error("Original controller stopped."));
  f.request.mockImplementation(async ticket => {
    observed ??= { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, controllerProcess: controller, nativeProcesses: partial ? [first] : [], lifecycle: "starting", activity: "initializing", nativeStopped: false, stoppedAt: null, error: null, startup: { state: "starting", reasonCode: "initializing" } };
    return { requestId: randomUUID(), ok: true, snapshot: observed };
  });
  const starting = await f.backend.advance(input, new AbortController().signal);
  expect(starting.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: mode === "explicit" });
  expect(starting.webExecution?.nativeProcesses).toEqual(partial ? [first] : []);
  const ticket = await f.launcher.prepare.mock.results.at(-1)!.value;
  f.store.updateWebExecution(starting, { ticketPath: path.join(f.home, "replacement-ticket.json") }, 21);
  vi.mocked(launchTickets.readLaunchTicket).mockResolvedValue(ticket);
  const saved = { ...observed, nativeProcesses: [first] };
  f.saved.mockReturnValue(saved);
  f.stopped.mockResolvedValue(false);
  const inspect = vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("running");
  vi.mocked(f.git.verifyWorktree).mockRejectedValueOnce(new Error("Temporary worktree deviation."));
  await expect(f.backend.advance(starting, new AbortController().signal)).rejects.toThrow("Temporary worktree");
  observed = { ...observed, nativeProcesses: [first, second], lifecycle: "ready", activity: "idle", startup: { state: "ready", reasonCode: "ready" } };
  f.launcher.prepare.mockClear(); f.launcher.launch.mockClear(); f.request.mockClear();
  const ready = await f.backend.advance(starting, new AbortController().signal);
  expect(ready.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: false });
  expect(ready.webExecution?.executionGeneration).toBe("2");
  expect(ready.webExecution?.controllerInstanceId).toBe(starting.webExecution?.controllerInstanceId);
  expect(ready.webExecution?.nativeProcesses).toEqual([first, second]);
  expect(ready.resources.nativeSession).toEqual(starting.resources.nativeSession);
  expect(f.store.getOrchestrationBlocker(ready)).toBeNull();
  expect(inspect.mock.calls.map(([proof]) => proof)).toEqual([controller, first, second]);
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
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

  const restored = f.store.clearShutdown(paused, 12);
  for (let i = 0; i < 3; i++) expect((await f.backend.advance(restored, new AbortController().signal)).recovery).toEqual(paused.recovery);
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it("does not let shutdown provenance revive a legacy exhausted failed generation", async () => {
  const f = await recoveryFixture();
  f.store.beginCleanup(f.task, { kind: "shutdown", deadline: 100 }, 8);

  const restored = f.store.clearShutdown(f.task, 11);
  const result = await f.backend.advance(restored, new AbortController().signal);
  expect(result.recovery.pauseReason).toContain("recovery budget is exhausted");
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it.each(["stopped", "ready"] as const)("persists legacy exhaustion before shutdown when the original writer is already gone (%s journal)", async lifecycleState => {
  const f = await recoveryFixture();
  f.saved.mockReturnValue({ ...f.snapshot, lifecycle: lifecycleState, error: null });
  const shutdown = await f.backend.cleanup(f.task, "shutdown", 20, undefined, true);
  expect(shutdown.task.recovery.pauseReason).toContain("recovery budget is exhausted");
  const restored = f.store.clearShutdown(shutdown.task, 21);
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
  expect(shutdown.task.recovery.pauseReason).toBeNull();
  const restored = f.store.clearShutdown(shutdown.task, 21);
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
  const current = { ...f.snapshot, executionGeneration: starting.webExecution!.executionGeneration, controllerInstanceId: starting.webExecution!.controllerInstanceId, lifecycle: "starting" as const, nativeStopped: false, stoppedAt: null, error: null };
  f.saved.mockReturnValue(current);
  vi.mocked(launchTickets.readLaunchTicket).mockResolvedValue(await f.launcher.prepare(starting));
  const shutdown = await f.backend.cleanup(starting, "shutdown", 30, undefined, true);
  expect(shutdown.task.recovery).toEqual({ count: 3, pauseReason: "The explicit recovery attempt stopped before a successful observation.", retryAuthorized: false });
  const restored = f.store.clearShutdown(shutdown.task, 31);
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

it.each((["worktree", "coordinator", "legacy_worktree"] as const).flatMap(source => (["automatic", "retry", "shutdown"] as const).map(mode => [source, mode] as const)))("hands a resolved %s block to authorized native %s recovery after complete process stop", async (source, mode) => {
  const f = await recoveryFixture(mode === "automatic" ? 3 : 2);
  f.store.blockOrchestration(f.task, { source, code: "branch_mismatch", message: "branch mismatch" }, 8);
  if (source === "legacy_worktree") f.store.pauseRecovery(f.task, "Native failure after legacy diagnosis.", 8, "recovery_blocked");
  if (mode === "retry") f.store.authorizeRecoveryRetry(f.task, 9);
  if (mode === "shutdown") {
    f.store.beginCleanup(f.task, { kind: "shutdown", deadline: 100 }, 9);
    f.store.clearShutdown(f.task, 10);
    f.saved.mockReturnValue({ ...f.snapshot, error: null });
  }
  f.request.mockImplementation(async ticket => {
    if (ticket.executionGeneration === "1") throw new Error("Original stopped controller is unreachable");
    return { requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, error: null } };
  });
  const result = await f.backend.advance(f.store.getTask(f.task)!, new AbortController().signal);
  if (source === "legacy_worktree" && mode !== "retry") {
    expect(result.recovery).toMatchObject({ count: 2, pauseReason: "Native failure after legacy diagnosis.", retryAuthorized: false });
    expect(result.webExecution?.executionGeneration).toBe("1");
    expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
    expect(f.launcher.launch).not.toHaveBeenCalled();
    return;
  }
  expect(result.webExecution?.executionGeneration).toBe("2");
  expect(result.recovery.count).toBe(mode === "shutdown" ? 2 : 3);
  expect(f.store.getOrchestrationBlocker(f.task)).toBeNull();
  expect(f.request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
});

it.each((["worktree", "coordinator", "legacy_worktree"] as const).flatMap(source => (["working", "paused"] as const).flatMap(lifecycleState => (["retry", "shutdown"] as const).map(mode => [source, lifecycleState, mode] as const))))("retains %s ownership while the native writer is %s during %s", async (source, lifecycleState, mode) => {
  const f = await orchestrationFixture();
  f.store.blockOrchestration(f.task, { source, code: "branch_mismatch", message: "Branch differs." }, 8);
  if (source === "legacy_worktree") f.store.pauseRecovery(f.task, "Native failure after legacy diagnosis.", 9, "recovery_blocked");
  if (mode === "retry") f.store.authorizeRecoveryRetry(f.task, 10);
  else { f.store.beginCleanup(f.task, { kind: "shutdown", deadline: 100 }, 10); f.store.clearShutdown(f.task, 11); }
  f.source.stopped.mockResolvedValue(false);
  f.source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, lifecycle: lifecycleState } });
  if (source === "legacy_worktree" && mode === "shutdown") await f.backend.advance(f.task, new AbortController().signal);
  else await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow();
  expect(f.store.getTask(f.task)?.webExecution?.executionGeneration).toBe("1");
  expect(f.store.getTask(f.task)?.recovery.count).toBe(0);
  expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
  expect(f.source.request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
});

it("reports real exhaustion after a worktree obstruction is resolved and the last native generation is proven stopped", async () => {
  const f = await recoveryFixture();
  f.store.blockOrchestration(f.task, { source: "worktree", code: "branch_mismatch", message: "branch mismatch" }, 8);
  f.request.mockRejectedValue(new Error("The original writer stopped."));
  const result = await f.backend.advance(f.task, new AbortController().signal);
  expect(result.recovery).toMatchObject({ count: 2, reasonCode: "recovery_limit", retryAuthorized: false });
  expect(result.webExecution?.executionGeneration).toBe("1");
  expect(f.store.getOrchestrationBlocker(f.task)).toBeNull();
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it("uses fresh confirmed initial delivery when a worktree block retained an older unknown observation", async () => {
  const f = await orchestrationFixture();
  f.store.updateWebExecution(f.task, { initialInputState: "unknown" }, 8);
  f.store.blockOrchestration(f.task, { source: "worktree", code: "branch_mismatch", message: "branch mismatch" }, 9);
  const result = await f.backend.advance(f.task, new AbortController().signal);
  expect(result.webExecution?.initialInputState).toBe("confirmed");
  expect(result.webExecution?.executionGeneration).toBe("1");
  expect(f.source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});

it.each(["unknown", "controller", "native", "generation", "claim", "session", "native-session", "not-stopped", "missing-stop-time", "alive", "changed-journal"] as const)("rejects unsafe evidence when retrying an allocated unsubmitted generation (%s)", async changed => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  f.launcher.prepare.mockRejectedValueOnce(new Error("Preparation temporarily unavailable."));
  await expect(f.backend.advance(f.store.authorizeRecoveryRetry(f.task, 9), new AbortController().signal)).rejects.toThrow("Preparation temporarily unavailable");
  const allocated = f.store.getTask(f.task)!;
  if (changed === "unknown") f.store.updateWebExecution(allocated, { launchSubmission: "unknown" }, 21);
  if (changed === "controller") f.store.updateWebExecution(allocated, { controllerProcess: f.snapshot.controllerProcess }, 21);
  if (changed === "native") f.store.updateWebExecution(allocated, { nativeProcesses: [f.snapshot.controllerProcess!] }, 21);
  const previous = { ...f.snapshot };
  if (changed === "generation") previous.executionGeneration = "0";
  if (changed === "claim") previous.claimId = randomUUID();
  if (changed === "session") previous.sessionId = randomUUID();
  if (changed === "native-session") previous.nativeSessionId = randomUUID();
  if (changed === "not-stopped") previous.nativeStopped = false;
  if (changed === "missing-stop-time") previous.stoppedAt = null;
  f.saved.mockReturnValue(previous);
  if (changed === "alive") f.stopped.mockResolvedValue(false);
  if (changed === "changed-journal") f.saved.mockReturnValueOnce(previous).mockReturnValue({ ...previous, error: "Evidence changed during inspection." });
  const retry = f.store.authorizeRecoveryRetry(f.task, 22);
  await expect(f.backend.advance(retry, new AbortController().signal)).rejects.toThrow();
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 3, retryAuthorized: false });
  expect(f.store.getTask(f.task)?.recovery.pauseReason).not.toBeNull();
  expect(f.store.getTask(f.task)?.webExecution?.executionGeneration).toBe("2");
  expect(f.store.getTask(f.task)?.webExecution?.launchId).toBe(allocated.webExecution!.launchId);
  expect(f.launcher.prepare).toHaveBeenCalledOnce(); expect(f.launcher.launch).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it("reports deletion failure separately from the retained native cleanup result", async () => {
  const f = await fixture(), failure = new Error("EACCES: denied directory");
  vi.mocked(f.git.removeWorktree).mockRejectedValueOnce(failure);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20 });
  await expect(backend.cleanup(f.store.getTask(f.identity)!, "terminal", 30)).rejects.toMatchObject({ stage: "worktree-removal", cause: failure });
  const pending = f.store.getTask(f.identity)!;
  expect(pending.cleanup).toMatchObject({ kind: "terminal", startedAt: 20, deadline: 30 });
  const completed = await backend.cleanup(pending, "terminal", 900_000);
  expect(completed.task.cleanup).toMatchObject({ kind: "terminal", startedAt: 20, deadline: 30 });
});

it.each([false, true])("shutdown stop proof is independent of unavailable Git discovery (already stopped=%s)", async alreadyStopped => {
  const f = await fixture();
  let task = f.store.getTask(f.identity)!;
  if (alreadyStopped) {
    task = f.store.beginCleanup(task, { kind: "terminal", deadline: 30 }, 10);

  }
  vi.mocked(f.git.findWorktree).mockRejectedValue(new Error("Git registry unavailable"));
  const archive = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive });
  const result = await backend.cleanup(task, "shutdown", 20, undefined, true);
  expect(result.task.cleanup).toMatchObject({ kind: alreadyStopped ? "terminal" : "shutdown" });
  if (alreadyStopped) expect(result.task.cleanup).toEqual(task.cleanup);
  expect(f.git.findWorktree).not.toHaveBeenCalled();
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
});

it("retries endpoint closure after native stop without replaying native cleanup", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const task = f.store.beginCleanup(source.task, { kind: "terminal", deadline: 30 }, 5);
  const endpoint = source.ticket.ipcEndpoint;
  const archive = vi.fn().mockResolvedValue(undefined);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request: source.request });
  if (process.platform !== "win32") {
    await mkdir(endpoint);
    await expect(backend.cleanup(task, "terminal", 900_000)).rejects.toMatchObject({ stage: "backend-close", cause: expect.objectContaining({ code: expect.stringMatching(/EISDIR|EPERM/) }) });
    expect(f.store.getTask(task)?.cleanup).toEqual({ kind: "terminal", startedAt: 5, deadline: 30 });
    await rm(endpoint, { recursive: true });
  }
  const completed = await backend.cleanup(task, "terminal", 900_000);
  expect(completed.complete).toBe(true);
  expect(completed.task.cleanup).toEqual({ kind: "terminal", startedAt: 5, deadline: 30 });
  expect(source.request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
  expect(archive).toHaveBeenCalledOnce();
  expect(f.git.removeWorktree).toHaveBeenCalledOnce();
});

it("reobserves recreated endpoint and Git resources after the local execution was marked done", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const binding = await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never);
  let worktreePresent = true;
  vi.mocked(f.git.findWorktree).mockImplementation(async () => worktreePresent ? binding : null);
  vi.mocked(f.git.removeWorktree).mockImplementation(async () => { worktreePresent = false; });
  const archive = vi.fn().mockResolvedValue(undefined);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request: source.request });
  const first = await backend.cleanup(source.task, "terminal", 100);
  expect(first.complete).toBe(true);
  const completed = f.store.completeTask(first.task, 21);
  worktreePresent = true;
  if (process.platform !== "win32") await writeFile(source.ticket.ipcEndpoint, "retained endpoint");
  const second = await backend.cleanup(completed, "terminal", 100);
  expect(second).toMatchObject({ complete: true, task: { status: "done" } });
  expect(worktreePresent).toBe(false);
  if (process.platform !== "win32") await expect(access(source.ticket.ipcEndpoint)).rejects.toMatchObject({ code: "ENOENT" });
  expect(source.stopped).toHaveBeenCalledTimes(2);
  expect(archive).toHaveBeenCalledTimes(2);
  expect(f.store.getTask(completed)?.cleanup).toEqual({ kind: "terminal", startedAt: 20, deadline: 100 });
});

it("requires observed Git absence after a successful deletion call", async () => {
  const f = await fixture();
  const binding = await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never);
  vi.mocked(f.git.findWorktree).mockResolvedValue(binding);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20 });
  await expect(backend.cleanup(f.store.getTask(f.identity)!, "terminal", 30)).rejects.toMatchObject({ stage: "worktree-removal", cause: expect.objectContaining({ message: expect.stringContaining("still has Git worktree resources") }) });
  expect(f.store.getTask(f.identity)?.status).toBe("active");
  expect(f.store.getTask(f.identity)?.cleanup).toEqual({ kind: "terminal", startedAt: 20, deadline: 30 });
});

it.each(["journal", "live"] as const)("preserves a native identity first learned from the %s during paused shutdown for explicit retry", async observedFrom => {
  const f = await fixture("codex", 0);
  const binding = await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never);
  const source = await cleanupSource(f, f.store.bindWorktree(f.identity, binding, 2));
  const nativeSessionId = randomUUID();
  const stoppedSnapshot = { ...source.snapshot, nativeSessionId };
  let journalSnapshot = observedFrom === "journal" ? stoppedSnapshot : source.snapshot;
  source.saved.mockImplementation(() => journalSnapshot);
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockResolvedValue(stoppedSnapshot);
  const paused = f.store.pauseRecovery(source.task, "Original launch requires explicit retry.", 6);
  expect(paused.resources.nativeSession).toBeNull();
  const request = vi.fn<typeof requestController>(async ticket => {
    if (ticket.executionGeneration === "1") {
      if (observedFrom === "journal") throw new Error("Original stopped controller is unreachable.");
      journalSnapshot = stoppedSnapshot;
      return { requestId: randomUUID(), ok: true, snapshot: stoppedSnapshot };
    }
    return { requestId: randomUUID(), ok: true, snapshot: { ...stoppedSnapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null } };
  });
  const launcher = {
    prepare: vi.fn(async (task: LocalTask): Promise<ControllerLaunchTicket> => ({ ...source.ticket, launchId: task.webExecution!.launchId, controllerInstanceId: task.webExecution!.controllerInstanceId, executionGeneration: task.webExecution!.executionGeneration, resumeNativeSessionId: task.resources.nativeSession!.sessionId })),
    launch: vi.fn(async () => {}), refreshGrant: vi.fn(async () => {}),
  };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, request });
  const shutdown = await backend.cleanup(paused, "shutdown", 20, undefined, true);
  expect(shutdown.complete).toBe(true);
  expect(shutdown.task.resources.nativeSession).toEqual({ source: "controller", sessionId: nativeSessionId });
  expect(shutdown.task.recovery.pauseReason).toBe(paused.recovery.pauseReason);
  const restored = f.store.clearShutdown(shutdown.task, 21);
  const resumed = await backend.advance(f.store.authorizeRecoveryRetry(restored, 22), new AbortController().signal);
  expect(resumed.resources.nativeSession).toEqual({ source: "controller", sessionId: nativeSessionId });
  expect(resumed.webExecution?.executionGeneration).toBe("2");
  expect(resumed.recovery).toEqual({ count: 1, pauseReason: null, retryAuthorized: false });
  await expect(launcher.prepare.mock.results[0]?.value).resolves.toMatchObject({ resumeNativeSessionId: nativeSessionId });
  expect(request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
});

it.each((["cleanup", "resume"] as const).flatMap(mode => (["valid", "known-job-lost", "known-job-changed", "core-changed", "wrong-launch"] as const).map(conflict => [mode, conflict] as const)))("verifies Windows controller proof enrichment before the first Worker observation (%s, %s)", async (mode, conflict) => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  const jobObjectName = `Local\\Daynight-${source.ticket.launchId}`;
  const cached = { ...source.snapshot.controllerProcess!, processGroupId: null, ...(conflict.startsWith("known-job") ? { jobObjectName } : {}) };
  const controller = { ...cached, jobObjectName };
  if (conflict === "known-job-lost") delete (controller as { jobObjectName?: string }).jobObjectName;
  if (conflict === "known-job-changed" || conflict === "wrong-launch") controller.jobObjectName = `Local\\Daynight-${randomUUID()}`;
  if (conflict === "core-changed") controller.parentPid += 1;
  const native = { ...cached, pid: 988, parentPid: cached.pid, startedAt: "native-original", commandHash: "b".repeat(64) };
  const nativeSessionId = randomUUID();
  const current = f.store.updateWebExecution(source.task, { controllerProcess: cached }, 6);
  const snapshot: ControllerSnapshot = { ...source.snapshot, controllerProcess: controller, nativeProcesses: [native], nativeSessionId,
    lifecycle: "ready", nativeStopped: false, stoppedAt: null,
    initialInputState: "confirmed", error: null, startup: { state: "ready", reasonCode: "ready" },
  };
  source.saved.mockReturnValue(snapshot); source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot });
  let stopped = false;
  source.stopped.mockImplementation(async () => stopped);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockImplementation(async () => {
    stopped = true; snapshot.lifecycle = "stopped"; snapshot.nativeStopped = true; snapshot.stoppedAt = new Date(50).toISOString();
  });
  const inspect = vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("running");
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockResolvedValue(snapshot);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "windows", buildPrompt: () => "managed", emit: () => {}, now: () => 50, request: source.request });
  if (mode === "resume") f.store.blockOrchestration(current, { source: "worktree", code: "branch_mismatch", message: "Temporary branch deviation." }, 7);
  const result = mode === "cleanup" ? backend.cleanup(current, "shutdown", 50) : backend.advance(current, new AbortController().signal);
  if (conflict !== "valid") {
    await expect(result).rejects.toThrow();
    expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
    expect(f.store.getTask(task)?.webExecution?.controllerProcess).toEqual(cached);
    expect(launcher.launch).not.toHaveBeenCalled();
    if (mode === "resume") expect(f.store.getOrchestrationBlocker(task)).not.toBeNull();
    return;
  }
  await result;
  expect(f.store.getTask(task)?.resources.nativeSession?.sessionId).toBe(nativeSessionId);
  expect(f.store.getTask(task)?.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
  expect(f.store.getTask(task)?.webExecution?.executionGeneration).toBe("1");
  if (mode === "resume") {
    expect(f.store.getOrchestrationBlocker(task)).toBeNull();
    expect(inspect.mock.calls.map(([proof]) => proof)).toEqual([controller, native]);
  } else {
    expect(source.stopped).toHaveBeenCalledWith(controller, [native]);
    expect(stop).toHaveBeenCalledWith(controller, [native], expect.any(Number));
  }
  expect(launcher.launch).not.toHaveBeenCalled();
  expect(source.request.mock.calls.map(([, action]) => action.kind)).toEqual(mode === "cleanup" ? ["observe", "stop"] : ["observe"]);
});

it.each((["none", "exhausted", "missing-native", "missing-process", "unproven-stop", "changed-stop-native", "changed-stop-process", "changed-stop-session"] as const).flatMap(conflict => [false, true].map(retry => [conflict, retry] as const)))("recovers the original unexpectedly stopped native after a lost initial response (conflict=%s, retry=%s)", async (conflict, retry) => {
  const f = await fixture("codex", conflict === "exhausted" ? 0 : 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "native-original", commandHash: "b".repeat(64) };
  const nativeSessionId = randomUUID();
  let recovering = false;
  let snapshot: ControllerSnapshot = { ...source.snapshot, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, initialInputState: "not_submitted", startup: { state: "ready", reasonCode: "ready" }, nativeSessionId: null, nativeProcesses: [native] };
  source.saved.mockImplementation(() => snapshot);
  source.stopped.mockImplementation(async () => recovering && conflict !== "unproven-stop");
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockImplementation(async () => ({ ...snapshot,
    ...(conflict === "changed-stop-native" ? { nativeSessionId: randomUUID() } : {}),
    ...(conflict === "changed-stop-session" ? { sessionId: randomUUID() } : {}),
    ...(conflict === "changed-stop-process" ? { nativeProcesses: [{ ...native, pid: 989 }] } : {}),
  }));
  source.request.mockImplementation(async (ticket, action) => {
    if (recovering) {
      if (ticket.executionGeneration === "1") throw new Error("Original controller unexpectedly exited.");
      return { requestId: randomUUID(), ok: true, snapshot: { ...snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", nativeStopped: false, stoppedAt: null, error: null } };
    }
    if (action.kind === "submit_initial") {
      snapshot = { ...snapshot, nativeSessionId, initialInputState: "confirmed" };
      throw new Error("Initial response was lost.");
    }
    return { requestId: randomUUID(), ok: true, snapshot };
  });
  const launcher = {
    prepare: vi.fn(async (record: LocalTask): Promise<ControllerLaunchTicket> => ({ ...source.ticket, launchId: record.webExecution!.launchId, executionGeneration: record.webExecution!.executionGeneration, controllerInstanceId: record.webExecution!.controllerInstanceId, resumeNativeSessionId: record.resources.nativeSession?.sessionId ?? null })),
    launch: vi.fn(async () => {}), refreshGrant: vi.fn(async () => {}),
  };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50, request: source.request });
  await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow("Initial response was lost");
  expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
  if (conflict === "exhausted") f.store.blockOrchestration(task, { source: "coordinator", code: "advance_failed", message: "Initial response was lost." }, 51);
  else {
    vi.mocked(f.git.verifyWorktree).mockRejectedValueOnce(new Error("Temporary worktree deviation."));
    await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow("Temporary worktree");
  }
  const blocker = f.store.getOrchestrationBlocker(task)!;
  expect(blocker.identity.nativeSessionId).toBeNull();
  snapshot = { ...snapshot, lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date(50).toISOString(), error: "Unexpected native exit." };
  if (conflict === "missing-native") snapshot.nativeSessionId = null;
  if (conflict === "missing-process") snapshot.nativeProcesses = [];
  recovering = true;
  const input = retry ? f.store.authorizeRecoveryRetry(task, 51) : f.store.getTask(task)!;
  launcher.prepare.mockClear(); launcher.launch.mockClear();
  if (conflict !== "none" && conflict !== "exhausted") {
    await expect(backend.advance(input, new AbortController().signal)).rejects.toThrow();
    expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
    expect(f.store.getOrchestrationBlocker(task)).toEqual(blocker);
    expect(f.store.getTask(task)?.recovery).toEqual(input.recovery);
    expect(launcher.prepare).not.toHaveBeenCalled(); expect(launcher.launch).not.toHaveBeenCalled();
    return;
  }
  const result = await backend.advance(input, new AbortController().signal);
  expect(result.resources.nativeSession?.sessionId).toBe(nativeSessionId);
  expect(result.webExecution?.executionGeneration).toBe(conflict === "exhausted" && !retry ? "1" : "2");
  if (conflict === "exhausted" && !retry) {
    expect(result.recovery).toMatchObject({ count: 0, reasonCode: "recovery_limit", retryAuthorized: false });
    expect(result.recovery.pauseReason).not.toBeNull();
    expect(launcher.launch).not.toHaveBeenCalled();
  } else expect(result.recovery).toEqual({ count: 1, pauseReason: null, retryAuthorized: false });
  expect(f.store.getOrchestrationBlocker(task)).toBeNull();
  const launches = await Promise.all(launcher.prepare.mock.results.map(result => result.value));
  expect(launches.every(ticket => ticket.resumeNativeSessionId === nativeSessionId)).toBe(true);
  expect(source.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
});

it.each([240_000, 300_001])("bounds Web worktree removal to five minutes (duration=%s)", async duration => {
  const f = await fixture();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 5 });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(f.git.removeWorktree).mockImplementationOnce(async (_project, _owner, operation) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { operation.signal.removeEventListener("abort", cancel); operation.check(); resolve(); }, duration);
    const cancel = (): void => { clearTimeout(timer); reject(operation.signal.reason); };
    operation.signal.addEventListener("abort", cancel, { once: true });
  }));
  const outcome = backend.cleanup(f.store.getTask(f.identity)!, "terminal", 600_005).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  now = Math.min(duration, 300_000);
  await vi.advanceTimersByTimeAsync(now);
  if (duration < 300_000) {
    expect((await outcome).complete).toBe(true);
  } else {
    expect(await outcome).toMatchObject({ stage: "worktree-removal", cause: { name: "OperationError", kind: "deadline" } });
    expect(f.store.getTask(f.identity)?.cleanup).toEqual({ kind: "terminal", startedAt: 5, deadline: 600_005 });
  }
});

it.each(["completed", "deadline", "cancelled", "startup-deadline"] as const)("uses the requested cleanup or startup provenance budget (%s)", async outcome => {
  const api = createWorkerSessionApi("https://daynight.example", "test-token");
  const identity = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID() };
  const cancellation = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // AbortSignal.timeout uses native timers, so route only its timer through the
  // controlled queue while preserving the signal's deadline behavior.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_target, init) => new Promise<Response>((resolve, reject) => {
    const signal = init!.signal!;
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(Response.json({ status: "not_registered", agentControlMode: "web", claimId: identity.claimId })); }, outcome === "completed" ? 60_000 : 300_001);
    const cancel = (): void => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
  })));
  let settled = false;
  const request = outcome === "startup-deadline" ? api.verifyUnregistered(identity, cancellation.signal) : api.verifyUnregistered(identity, cancellation.signal, CLEANUP_OPERATION_MS);
  const result = request.then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(30_001);
  if (outcome === "startup-deadline") {
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    return;
  }
  expect(settled).toBe(false);
  if (outcome === "cancelled") {
    cancellation.abort(new Error("cleanup cancelled"));
    expect(await result).toBe(cancellation.signal.reason);
  } else {
    await vi.advanceTimersByTimeAsync((outcome === "completed" ? 60_000 : 300_000) - 30_001);
    if (outcome === "completed") expect(await result).toBeNull();
    else expect(await result).toMatchObject({ name: "TimeoutError" });
  }
});

it("reports persisted startup uncertainty while paused without launching and preserves revision on unchanged observation", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  source.snapshot.startup = { state: "unknown", reasonCode: "native_timeout" };
  source.snapshot.error = "Native initialize response timed out; result is unknown.";
  const paused = f.store.pauseRecovery(source.task, "Original launch has no proven native identity.", 6);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  const first = backend.observeStartupReport(paused);
  expect(first).toMatchObject({ schemaVersion: 1, claimId: paused.claimId, revision: "1", startup: { state: "unknown", reasonCode: "native_timeout" }, recovery: { state: "blocked", reasonCode: "recovery_blocked" } });
  expect(backend.observeStartupReport(paused)).toEqual(first);
  expect(f.store.getTask(paused)?.recovery).toEqual(paused.recovery);
  expect(launcher.prepare).not.toHaveBeenCalled(); expect(launcher.launch).not.toHaveBeenCalled();
  source.snapshot.startup = { state: "failed", reasonCode: "native_rejected" };
  expect(backend.observeStartupReport(paused)?.revision).toBe("2");
});

it("does not consume another generation's startup evidence", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  source.snapshot.startup = { state: "ready", reasonCode: "ready" };
  source.snapshot.controllerInstanceId = randomUUID();
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  expect(backend.observeStartupReport(source.task)?.startup).toEqual({ state: "unknown", reasonCode: "evidence_missing" });
  expect(f.store.getTask(source.task)?.resources.nativeSession).toBeNull();
});

it("does not report a stopped incomplete initialization as still starting", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  source.snapshot.startup = { state: "starting", reasonCode: "initializing" };
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  expect(backend.observeStartupReport(source.task)?.startup).toEqual({ state: "unknown", reasonCode: "controller_start_unknown" });
});
