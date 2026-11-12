import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, vi } from "vitest";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as launchTickets from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { requestController } from "../../../src/commands/controller/local-client.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

import { frozenToolLaunch } from "../../helpers/tool-launch.js";

export const createWebBackendFixtures = (storage: "memory" | "file") => {
  const children: ChildProcess[] = [];

  const roots:string[]=[];

  const stores:ReturnType<typeof openWebExecutionStore>[]=[];

  afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();for (const child of children.splice(0)) { child.kill("SIGKILL"); if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("exit", () => resolve())); }for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

  const fixture=async(agent: "codex" | "claude" | "copilot" = "codex", recoveryLimit = 2)=>{
   const base=path.resolve(import.meta.dirname,"../../../../../.tmp/web-backend-tests");await mkdir(base,{recursive:true});const home=await mkdtemp(path.join(base,"h-"));roots.push(home);
   const store=openWebExecutionStore(storage === "memory" ? createMemoryDatabase() : path.join(home,"worker.sqlite"));stores.push(store);
   const project={serverOrigin:"https://daynight.example",projectId:randomUUID(),repoUrl:"https://example.test/repo.git",localPath:home};
   const identity={...project,taskId:randomUUID(),claimId:randomUUID(),workerId:randomUUID(),worktreeId:randomUUID()};
   store.register({ ...identity, project, configuration: {agent,agentControlMode:"web",model:null,args:[],recoveryLimit,...(agent === "claude" ? {} : {toolLaunch:frozenToolLaunch(agent)})}, userId: randomUUID() }, 1);
   const binding={repositoryPath:home,commonDirectory:path.join(home,".git"),worktreePath:path.join(home,".worktrees","daynight",identity.worktreeId),branch:`daynight/${identity.taskId}`};
   await mkdir(binding.worktreePath,{recursive:true});
   const git={prepareWorktree:vi.fn(async()=>binding),verifyWorktree:vi.fn(async()=>binding),resolveWorktreeBinding:vi.fn(async()=>binding),removeUnpublishedReservation:vi.fn(async()=>{}),findWorktree:vi.fn(async()=>null),removeWorktree:vi.fn(async()=>({kind:"absent",effectErrors:[]})),prepareRepository:vi.fn(),dispose:vi.fn()} as unknown as WorkerGitManager;
   return {home,store,identity,git};
  };

  const cleanupSource = async (f: Awaited<ReturnType<typeof fixture>>, input: LocalTask, launchSubmission: "acknowledged" | "unknown" = "acknowledged") => {
    let task = input.webExecution === null ? f.store.initializeWebExecution(input, 3) : input;
    task = f.store.updateWebExecution(task, { sessionId: task.webExecution!.sessionId ?? randomUUID(), initialPrompt: "managed", launchSubmission, controllerProcess: { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) } }, 4);
    const execution = task.webExecution!;
    const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: task.configuration!.agent, cwd: task.resources.worktree?.worktreePath ?? f.home, nativeHome: path.join(f.home, ".native"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: task.resources.nativeSession?.sessionId ?? null, credentialFile: path.join(f.home, "grant.json"), ipcEndpoint: path.join(f.home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString() };
    task = f.store.updateWebExecution(task, { ticketPath: await launchTickets.writeLaunchTicket(f.home, ticket) }, 5);
    const snapshot: ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: ticket.sessionId, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: task.resources.nativeSession?.sessionId ?? null, initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: task.webExecution!.controllerProcess, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date(0).toISOString(), error: null };
    const saved = vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
    const stopped = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
    vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
    const request = vi.fn<typeof requestController>().mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot });
    return { task, ticket, snapshot, saved, stopped, request };
  };

  const orchestrationFixture = async () => {
    const f = await fixture("codex", 3);
    let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
    task = f.store.bindNativeSession(task, { source: "controller", sessionId: randomUUID() }, 3);
    const source = await cleanupSource(f, task);
    const nativeProcess = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "native-original", commandHash: "b".repeat(64) };
    const snapshot: ControllerSnapshot = { ...source.snapshot, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null, startup: { state: "ready", reasonCode: "ready" }, nativeProcesses: [nativeProcess] };
    task = f.store.updateWebExecution(source.task, { initialInputState: "confirmed", activity: "working", nativeProcesses: [nativeProcess] }, 6);
    source.saved.mockReturnValue(snapshot); source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot });
    vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("running");
    const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
    const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50_000, request: source.request });
    const report = f.store.observeStartup(task, snapshot.startup!, 10_000)!;
    return { ...f, task, source, snapshot, launcher, backend, report };
  };

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
  return { children, stores, fixture, cleanupSource, orchestrationFixture, recoveryFixture };
};
