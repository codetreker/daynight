import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The durable workspace fixture remains in the test process when the worker dies.
// The worker child uses the built module directly, with no installed CLI or server.
it.skipIf(process.platform === "win32")("reattaches the original native session after a worker process is killed without repeating its assignment", async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/execution-crash");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "run-"));
  const owner = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  const project = { projectId: owner.projectId, repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") };
  const cwd = path.join(project.localPath, ".worktrees", "daynight", owner.taskId);
  await mkdir(cwd, { recursive: true });
  const nativeId = uuid(7), events: { method: string; params: Record<string, unknown> }[] = [];
  const workspaces: Record<string, unknown>[] = [], panes: Record<string, unknown>[] = [], agents: Record<string, unknown>[] = [], tabs: Record<string, unknown>[] = [];
  const children: ChildProcess[] = [];
  const executionUrl = new URL("../../../dist/commands/worker/execution.js", import.meta.url).href;
  const storeUrl = new URL("../../../dist/commands/worker/store.js", import.meta.url).href;
  const agentUrl = new URL("../../../dist/commands/worker/herdr/agents.js", import.meta.url).href;
  const source = `
import { createExecutionDriver } from ${JSON.stringify(executionUrl)};
import { openWorkerStore } from ${JSON.stringify(storeUrl)};
import { createHerdrAgentManager } from ${JSON.stringify(agentUrl)};
const c=JSON.parse(process.argv[1]);
let sequence=0; const pending=new Map();
process.on('message',m=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);});
const rpc={request:(method,params,operation)=>{operation.check();return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});process.send({kind:'rpc',id,method,params});});}};
const store=openWorkerStore(c.database,{onMigration:()=>{}});
store.registerProject(c.project);
let task=store.getTask(c.owner);
if(task===null){store.registerPending({...c.owner,agent:'codex'});task=store.activateTask(c.owner);}
const manager=createHerdrAgentManager({rpc,session:'w',preflight:{verifyStart:async()=>{}},workspaceEnvironment:{XDG_CONFIG_HOME:'',XDG_STATE_HOME:''},pollIntervalMs:1});
const worktree={repositoryPath:c.project.localPath,commonDirectory:c.project.localPath+'/.git',worktreePath:c.cwd,branch:'daynight/'+c.owner.taskId};
const git={prepareWorktree:async()=>worktree,verifyWorktree:async()=>worktree};
const driver=createExecutionDriver({store,git,herdr:{tasks:manager},readTask:async()=>{throw new Error('Unexpected ownership request')},platform:'linux',workerId:c.workerId,serverOrigin:'https://daynight.example',buildPrompt:()=>c.prompt,emit:()=>{},now:Date.now});
const result=await driver.advance({task,project:c.project,owner:c.owner,title:'Crash fixture',configuration:{agent:'codex',model:null,args:[],recoveryLimit:2}});
process.send({kind:'ready',sessionId:result.nativeSession?.sessionId,stored:store.getTask(task)});
setInterval(()=>{},1000);
`;
  const rpc = (method: string, params: Record<string, unknown>): Record<string, unknown> => {
    events.push({ method, params });
    if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { workspaces, panes, agents, tabs } };
    if (method === "workspace.create") {
      const workspace = { workspace_id: "workspace", label: params.label };
      const pane = { workspace_id: "workspace", pane_id: "pane", terminal_id: "terminal", tab_id: "tab", cwd: params.cwd, agent_status: "idle", interactive_ready: false, launch_pending: false };
      const tab = { workspace_id: "workspace", tab_id: "tab" };
      workspaces.push(workspace); panes.push(pane); tabs.push(tab);
      return { type: "workspace_created", workspace, root_pane: pane, tab };
    }
    if (method === "agent.start") {
      const agent = { ...panes[0], agent: "codex", name: params.name, agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 };
      agents.push(agent);
      return { type: "agent_started", agent, argv: ["codex", ...(params.args as string[])] };
    }
    if (method === "agent.read") return { type: "pane_read", read: { pane_id: "pane", workspace_id: "workspace", source: "visible", format: "text", text: "› Ask Codex to do anything\n", truncated: false } };
    if (method === "agent.prompt") {
      const receipt = structuredClone(agents[0]!);
      Object.assign(agents[0]!, { agent_status: "working", state_change_seq: 2, agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: nativeId } });
      return { type: "agent_prompted", agent: receipt };
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  };
  const start = () => {
    const config = { owner, project, cwd, database: path.join(root, "worker.sqlite"), workerId: uuid(5), prompt: "Assignment: original claim" };
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, JSON.stringify(config)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (value: Buffer) => { stderr += value.toString(); });
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker fixture timed out: ${stderr}`)), 10_000);
      child.on("message", (value: unknown) => {
        const message = value as { kind: string; id: number; method: string; params: Record<string, unknown> };
        if (message.kind === "rpc") {
          try { child.send({ id: message.id, result: rpc(message.method, message.params) }); }
          catch (error) { child.send({ id: message.id, error: String(error) }); }
        } else if (message.kind === "ready") { clearTimeout(timer); resolve(value as Record<string, unknown>); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Worker fixture exited: ${stderr}`)); });
    });
    return { child, ready };
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker fixture did not exit after SIGKILL.")), 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (!child.kill("SIGKILL")) { clearTimeout(timer); reject(new Error("Could not stop worker fixture.")); }
    });
  };
  try {
    const stored = { projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, status: "active", sessionId: nativeId };
    const first = start();
    expect(await first.ready).toMatchObject({ sessionId: nativeId, stored });
    await stop(first.child);
    expect(first.child.signalCode).toBe("SIGKILL");
    const restarted = start();
    expect(await restarted.ready).toMatchObject({ sessionId: nativeId, stored });
    expect(workspaces[0]!.label).toBe(`Crash fixture | daynight:${JSON.stringify(owner)}`);
    expect(events.filter(({ method }) => method === "workspace.create")).toHaveLength(1);
    expect(events.filter(({ method }) => method === "agent.start")).toHaveLength(1);
    expect(events.filter(({ method }) => method === "agent.prompt").map(({ params }) => params.text)).toEqual(["Assignment: original claim"]);
  } finally {
    const cleanup = await Promise.allSettled(children.map(stop));
    await rm(root, { recursive: true, force: true });
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map(({ reason }) => reason), "Worker fixture cleanup failed.");
  }
}, 25_000);
