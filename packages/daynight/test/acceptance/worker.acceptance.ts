import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import crossSpawn from "cross-spawn";
import { stringify as yaml } from "yaml";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Project, Task, UpdateWorkerClaimInput, WorkerClaimDescriptor } from "../../src/api/types.js";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const primary = path.basename(path.dirname(workspace)) === ".worktrees" ? path.resolve(workspace, "../..") : workspace;
const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const time = "2026-10-26T00:00:00Z";
type Event = { kind: string; pid?: number; taskId?: string; text?: string; row?: { status: string; configuration: string }; projectCount?: number; binding?: unknown; argv?: string[] };
type FixtureTask = { -readonly [Key in keyof Task]: Task[Key] };

const daemon = String.raw`#!/usr/bin/env node
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write('herdr 0.9.5\n'); process.exit(0); }
const require=createRequire(import.meta.url), Database=require(process.env.FIXTURE_SQLITE);
const events=process.env.FIXTURE_EVENTS;
const event=async(value)=>appendFile(events,JSON.stringify(value)+'\n');
const db=()=>new Database(path.join(process.env.HOME,'.daynight','worker','state.sqlite'),{readonly:true});
const record=async(kind,taskId,extra={})=>{const sql=db();try{await event({kind,taskId,row:sql.prepare('SELECT status,configuration FROM tasks WHERE task_id=?').get(taskId),projectCount:sql.prepare('SELECT count(*) AS count FROM projects').get().count,...extra});}finally{sql.close();}};
const directory=path.join(process.env.XDG_CONFIG_HOME,'herdr','sessions','w');await mkdir(directory,{recursive:true});
const workspaces=[],panes=[],agents=[],tabs=[],children=new Map();let next=0;
const clone=(value)=>JSON.parse(JSON.stringify(value));
const snapshot=()=>({workspaces:clone(workspaces),panes:clone(panes),agents:clone(agents),tabs:clone(tabs)});
const owner=(pane)=>JSON.parse(workspaces.find(w=>w.workspace_id===pane.workspace_id).label.slice('daynight:'.length));
const stop=async(paneId)=>{const child=children.get(paneId);if(!child)return;if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await closed;}children.delete(paneId);};
const sockets=new Set();let shutting=false;
const api=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let input='';socket.on('data',async chunk=>{input+=chunk.toString();const end=input.indexOf('\n');if(end<0)return;const request=JSON.parse(input.slice(0,end));input='';const p=request.params;let result;
try {
switch(request.method){
case 'ping':result={type:'pong',version:'0.9.5',protocol:22,capabilities:{detached_server_daemon:true}};break;
case 'session.snapshot':result={type:'session_snapshot',snapshot:snapshot()};break;
case 'integration.list':result={type:'integration_list',integrations:[{target:'codex',state:'current'}]};break;
case 'workspace.create':{const id=String(++next),workspace={workspace_id:'w'+id,label:p.label},pane={workspace_id:workspace.workspace_id,pane_id:'p'+id,terminal_id:'t'+id,cwd:p.cwd,agent_status:'idle',launch_pending:false,interactive_ready:false},tab={workspace_id:workspace.workspace_id,tab_id:'tab'+id};workspaces.push(workspace);panes.push(pane);tabs.push(tab);await record('workspace',owner(pane).taskId,{binding:pane});result={type:'workspace_created',workspace,root_pane:pane,tab};break;}
case 'agent.start':{const pane=panes.find(item=>item.pane_id===p.pane_id);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});children.set(p.pane_id,child);const agent={...pane,agent:p.kind,name:p.name,agent_status:'idle',interactive_ready:true,launch_pending:false,state_change_seq:1,completion_seq:0};agents.push(agent);const argv=[p.kind,...p.args];await record('native-start',owner(pane).taskId,{argv});result={type:'agent_started',agent,argv};break;}
case 'agent.prompt':{const agent=agents.find(item=>item.pane_id===p.target),pane=panes.find(item=>item.pane_id===p.target);const receipt=clone(agent);const identity=owner(pane);await event({kind:'prompt',taskId:identity.taskId,text:p.text});if(!agent.agent_session){const id='00000000-0000-4000-8000-'+String(++next).padStart(12,'0');agent.agent_session={source:'herdr:codex',agent:'codex',kind:'id',value:id};const history=path.join(process.env.CODEX_HOME,'sessions');await mkdir(history,{recursive:true});await writeFile(path.join(history,'rollout-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:pane.cwd}})+'\n');}agent.state_change_seq+=2;agent.completion_seq+=1;agent.agent_status='idle';result={type:'agent_prompted',agent:receipt};break;}
case 'pane.process_info':{const pane=panes.find(item=>item.pane_id===p.pane_id),child=children.get(p.pane_id);result={type:'pane_process_info',process_info:{pane_id:p.pane_id,shell_pid:process.pid,foreground_process_group_id:child?child.pid:process.pid,foreground_processes:child?[{pid:child.pid,name:'codex',argv0:'codex'}]:[]}};break;}
case 'tab.create':{const id=String(++next),pane={workspace_id:p.workspace_id,pane_id:'p'+id,terminal_id:'t'+id,cwd:p.cwd,agent_status:'idle',launch_pending:false,interactive_ready:false},tab={workspace_id:p.workspace_id,tab_id:'tab'+id,label:p.label};panes.push(pane);tabs.push(tab);result={type:'tab_created',tab,root_pane:pane};break;}
case 'pane.close':{const pane=panes.find(item=>item.pane_id===p.pane_id);await event({kind:'native-stop',taskId:owner(pane).taskId});await stop(p.pane_id);for(const items of [panes,agents]){const index=items.findIndex(item=>item.pane_id===p.pane_id);if(index>=0)items.splice(index,1);}result={type:'ok'};break;}
case 'workspace.close':{const workspace=workspaces.find(item=>item.workspace_id===p.workspace_id);const taskId=JSON.parse(workspace.label.slice('daynight:'.length)).taskId;for(const pane of panes.filter(item=>item.workspace_id===p.workspace_id))await stop(pane.pane_id);for(const items of [workspaces,panes,agents,tabs])for(let i=items.length-1;i>=0;i--)if(items[i].workspace_id===p.workspace_id)items.splice(i,1);await event({kind:'workspace-close',taskId});result={type:'ok'};break;}
case 'server.stop':result={type:'ok'};if(!shutting){shutting=true;setTimeout(async()=>{for(const pane of panes)await stop(pane.pane_id);for(const item of sockets)item.destroy();api.close();client.close();await event({kind:'daemon-stop',pid:process.pid});process.exit(0);},10);}break;
default:throw new Error('Unexpected fixture method '+request.method);
}
socket.end(JSON.stringify({id:request.id,result})+'\n');
}catch(error){await event({kind:'fixture-error',message:error.stack});socket.end(JSON.stringify({id:request.id,error:{code:'fixture_error',message:error.message}})+'\n');}
});});
const client=createServer(socket=>socket.end());await new Promise(resolve=>api.listen(path.join(directory,'herdr.sock'),resolve));await new Promise(resolve=>client.listen(path.join(directory,'herdr-client.sock'),resolve));await event({kind:'daemon-start',pid:process.pid});
`;

const metadata = String.raw`#!/usr/bin/env node
import path from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--version'))process.stdout.write('codex-cli 0.164.0\n');
else if(args.includes('--help'))process.stdout.write('--no-daemon\n');
else if(args.includes('features'))process.stdout.write('hooks stable true\n');
else throw new Error('Only metadata commands are permitted in this fixture');
`;

it.skipIf(process.platform !== "linux")("runs the installed worker through claim, managed launch, terminal cleanup and startup Ctrl+C after a crash", async () => {
  const scratch = path.join(primary, ".tmp");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, "w"));
  const eventsFile = path.join(home, "events.jsonl");
  const databaseFile = path.join(home, ".daynight/worker/state.sqlite");
  const evidenceFile = path.join(workspace, ".tmp/installed-worker-acceptance.json");
  const logs: string[] = [];
  const requests: { method: string; path: string; taskId?: string }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let installed: Awaited<ReturnType<typeof createInstalledCli>> | undefined;
  let failure: unknown;
  let holdProjectReads = false;
  let heldProjectReads = 0;
  const projects: Project[] = [1, 2].map((number) => ({ id: uuid(number), name: `Repo ${number}`, repoUrl: `https://git.example/worker/repo-${number}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }));
  const tasks: FixtureTask[] = projects.map((project, index) => ({ id: uuid(index + 10), projectId: project.id, title: `Managed ${index + 1}`, description: "Fixture task", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: true, requiredPlatform: "linux", version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true }));
  const send = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(stringifyApiJson(value)); };
  const refusal = (response: ServerResponse): void => send(response, { error: { code: "version_conflict", message: "Fixture version conflict", requestId: "worker-fixture" } }, 409);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8"));
      const parts = url.pathname.split("/");
      const project = projects.find((item) => item.id === parts[4]);
      const task = tasks.find((item) => item.id === parts[6]);
      requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, ...(task === undefined ? {} : { taskId: task.id }) });
      if (project !== undefined && parts.length === 5 && request.method === "GET") {
        if (holdProjectReads) { heldProjectReads++; return; }
        send(response, project); return;
      }
      if (project !== undefined && parts.length === 6 && request.method === "GET") {
        const inventory = url.searchParams.get("workerId");
        const items = tasks.filter((item) => item.projectId === project.id && (inventory === null ? item.ready && item.allowAgents : item.properties.worker?.state === "active" && item.properties.worker.workerId === inventory));
        send(response, { items, nextCursor: null }); return;
      }
      if (task !== undefined && parts[7] === "worker-claim" && request.method === "POST") {
        const input = body as WorkerClaimDescriptor & { version: bigint };
        if (input.version !== task.version || !task.ready || task.properties.worker?.state === "active") { refusal(response); return; }
        task.properties = { ...task.properties, worker: { claimId: input.claimId, workerId: input.workerId, machine: input.machine, platform: input.platform, agent: input.agent, worktreeId: input.worktreeId, state: "active", userId: uuid(100), phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: time } };
        task.status = "in_progress"; task.ready = false; task.startedAt = time; task.version += 1n;
        send(response, task); return;
      }
      if (task !== undefined && parts[7] === "worker-claim" && request.method === "PATCH") {
        const input = body as UpdateWorkerClaimInput;
        if (input.version !== task.version || task.properties.worker?.state !== "active" || task.properties.worker.claimId !== input.claimId) { refusal(response); return; }
        task.properties = { ...task.properties, worker: { ...task.properties.worker, ...(input.herdr === undefined ? {} : { herdr: input.herdr }), ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }), ...(input.phase === undefined ? {} : { phase: input.phase }) } };
        task.version += 1n;
        send(response, task); return;
      }
      throw new Error(`Unexpected installed worker API call ${request.method} ${url.pathname}`);
    } catch (error) {
      logs.push(error instanceof Error ? error.stack! : String(error));
      send(response, { error: { code: "internal_error", message: "Fixture error", requestId: "worker-fixture" } }, 500);
    }
  });
  const events = async (): Promise<Event[]> => {
    let source: string;
    try { source = await readFile(eventsFile, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
    return source.slice(0, source.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
  };
  const row = (taskId: string) => {
    const db = new Database(databaseFile, { readonly: true });
    try { return db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as { status: string; native_execution: string; cleanup: string; resources: string }; }
    finally { db.close(); }
  };
  const waitFor = async (label: string, condition: () => boolean | Promise<boolean>, timeout = 20_000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (!await condition()) {
      if (Date.now() >= deadline) throw new Error(`Installed worker did not reach ${label}.\n${logs.join("")}\n${JSON.stringify(await events())}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    installed = await createInstalledCli();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing worker fixture address.");
    const bin = path.join(home, "bin");
    const codex = path.join(home, "c");
    await mkdir(bin); await mkdir(codex);
    const hook = path.join(codex, "herdr-agent-state.sh");
    await writeFile(hook, "# Controlled official-integration metadata fixture\n");
    await writeFile(path.join(codex, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `bash '${hook}' session` }] }] } }));
    await writeFile(path.join(bin, "herdr"), daemon, { mode: 0o700 });
    await writeFile(path.join(bin, "codex"), metadata, { mode: 0o700 });
    const repositoryPaths = projects.map((_project, index) => path.join(home, `r${index + 1}`));
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|HERDR_|DAYNIGHT_|NODE_OPTIONS$)/i.test(key)) delete environment[key];
    Object.assign(environment, { HOME: home, USERPROFILE: home, CODEX_HOME: codex, PATH: `${bin}${path.delimiter}${process.env.PATH!}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", FIXTURE_EVENTS: eventsFile, FIXTURE_SQLITE: createRequire(import.meta.url).resolve("better-sqlite3") });
    for (const [index, repository] of repositoryPaths.entries()) {
      await mkdir(repository);
      const git = (args: string[]) => execFileSync("git", args, { cwd: repository, env: environment, stdio: "pipe", timeout: 10_000 });
      git(["init", "--initial-branch=main"]);
      git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
      git(["remote", "add", "origin", projects[index]!.repoUrl]);
      await writeFile(path.join(repository, "README.md"), "Worker integration fixture\n");
      git(["add", "README.md"]); git(["commit", "-m", "Create fixture"]);
    }
    await mkdir(path.join(home, ".daynight"));
    await writeFile(path.join(home, ".daynight/config.yml"), yaml({ serverUrl: `http://127.0.0.1:${address.port}`, serverToken: "worker-fixture-token", worker: { agent: "codex", model: "fixture-model", args: ["--search"], maxConcurrent: 1, pollIntervalMs: 50, repositories: projects.map((project, index) => ({ remote: project.repoUrl, path: repositoryPaths[index], projectId: project.id })) } }));
    const start = () => {
      const child = crossSpawn(installed!.receipt.launcherPath, ["worker", "run"], { cwd: home, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
      child.stdout!.on("data", (value: Buffer) => { logs.push(value.toString()); });
      child.stderr!.on("data", (value: Buffer) => { logs.push(value.toString()); });
      const closed = new Promise<number | null>((resolve, reject) => { child.once("close", (code) => { children.delete(child); resolve(code); }); child.once("error", reject); });
      children.set(child, closed);
      return { child, closed };
    };
    const originalWorker = start();
    await waitFor("first managed prompt", async () => (await events()).some((event) => event.kind === "prompt" && event.taskId === tasks[0]!.id));
    await waitFor("first prompt journal", () => JSON.parse(row(tasks[0]!.id).native_execution).promptSubmission === "submitted");
    const first = tasks[0]!;
    first.status = "done"; first.ready = false; first.completedAt = time; first.version += 1n;
    first.properties = { ...first.properties, worker: { ...first.properties.worker!, state: "completed" } };
    await waitFor("first cleanup and second managed prompt", async () => row(first.id).status === "done" && (await events()).some((event) => event.kind === "prompt" && event.taskId === tasks[1]!.id));
    await waitFor("second prompt journal", () => JSON.parse(row(tasks[1]!.id).native_execution).promptSubmission === "submitted");
    expect(originalWorker.child.kill("SIGKILL")).toBe(true);
    expect(await originalWorker.closed).toBeNull();
    expect((await events()).filter((event) => event.kind === "daemon-stop")).toHaveLength(0);
    holdProjectReads = true;
    const restartedWorker = start();
    await waitFor("restarted worker held during project discovery", () => heldProjectReads > 0);
    expect(restartedWorker.child.kill("SIGINT")).toBe(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([restartedWorker.closed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Installed worker shutdown timed out.\n${logs.join("")}`)), 20_000); })]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    expect(code, logs.join("")).toBe(0);
    const observed = await events();
    expect(observed.filter((event) => event.kind === "fixture-error")).toEqual([]);
    expect(observed.filter((event) => event.kind === "native-start").map((event) => event.taskId)).toEqual(tasks.map((task) => task.id));
    for (const event of observed.filter((item) => item.kind === "workspace" || item.kind === "native-start")) {
      expect(event.row?.status).toBe("active");
      expect(JSON.parse(event.row!.configuration)).toEqual({ agent: "codex", model: "fixture-model", args: ["--search"], recoveryLimit: 3 });
      expect(event.projectCount).toBe(2);
    }
    for (const [index, task] of tasks.entries()) {
      const initial = observed.filter((event) => event.kind === "prompt" && event.taskId === task.id && event.text!.includes("Assignment:"));
      expect(initial).toHaveLength(1);
      expect(initial[0]!.text).toContain("worker-managed");
      expect(initial[0]!.text).toContain("using-daynight");
      expect(initial[0]!.text).toContain("execute-task-in-managed");
      expect(initial[0]!.text).toContain("references/execute-task-in-managed.md");
      expect(initial[0]!.text).toContain(task.properties.worker!.claimId);
      expect(initial[0]!.text).toContain(path.join(repositoryPaths[index]!, ".worktrees/daynight", task.id));
      expect(initial[0]!.text).not.toContain("worker-fixture-token");
      expect(JSON.parse(initial[0]!.text!.split("Assignment:")[1]!)).toMatchObject({
        projectId: task.projectId, taskId: task.id, claimId: task.properties.worker!.claimId,
        workerId: task.properties.worker!.workerId, worktreeId: task.properties.worker!.worktreeId,
        worktreePath: path.join(repositoryPaths[index]!, ".worktrees/daynight", task.id),
        branch: `daynight/${task.id}`, platform: "linux", nativeSession: null,
        configuration: { agent: "codex", model: "fixture-model", args: ["--search"], recoveryLimit: 3 },
      });
      expect(observed.filter((event) => event.kind === "prompt" && event.taskId === task.id)).toHaveLength(2);
    }
    expect(observed.filter((event) => event.kind === "daemon-start")).toHaveLength(1);
    expect(observed.filter((event) => event.kind === "daemon-stop")).toHaveLength(1);
    expect(observed.filter((event) => event.kind === "native-stop")).toHaveLength(2);
    expect(observed.filter((event) => event.kind === "workspace-close")).toHaveLength(2);
    expect(observed.findIndex((event) => event.kind === "native-start" && event.taskId === tasks[1]!.id)).toBeGreaterThan(observed.findIndex((event) => event.kind === "workspace-close" && event.taskId === first.id));
    expect(requests.filter((request) => request.method === "POST").map((request) => request.taskId)).toEqual(tasks.map((task) => task.id));
    expect(requests.some((request) => request.method === "GET" && /^\/api\/v1\/projects\/[^/]+\/tasks\/[^/?]+$/.test(request.path))).toBe(false);
    expect(row(first.id).status).toBe("done");
    await expect(readFile(path.join(repositoryPaths[0]!, ".worktrees/daynight", first.id, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const unfinished = row(tasks[1]!.id);
    expect(unfinished.status).toBe("active");
    expect(JSON.parse(unfinished.cleanup)).toMatchObject({ kind: "shutdown", agentStopped: true, workspaceClosed: true, worktreeDeleted: false });
    expect(await readFile(path.join(repositoryPaths[1]!, ".worktrees/daynight", tasks[1]!.id, "README.md"), "utf8")).toContain("Worker integration fixture");
    const originalNativeId = JSON.parse(unfinished.resources).nativeSession.sessionId as string;
    expect(originalNativeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(path.join(codex, "sessions", `rollout-${originalNativeId}.jsonl`), "utf8")).toContain(path.join(repositoryPaths[1]!, ".worktrees/daynight", tasks[1]!.id));
    expect(tasks[1]!.properties.worker!.state).toBe("active");
    await writeFile(evidenceFile, JSON.stringify({ outcome: "passed", method: "Installed public launcher, real Git/SQLite/HTTP; controlled Herdr and Codex metadata/native-process substitutes; SIGKILL then SIGINT during held restart project GET", nativeAgentExecution: false, receipt: installed.receipt, requests, events: observed, first: row(first.id), unfinished, limitations: ["Linux controlled fixture only", "Does not establish model execution or native Herdr qualification", "Two-repository progression does not establish sustained-load fairness"] }, null, 2));
  } catch (error) {
    failure = error;
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, JSON.stringify({ outcome: "failed", method: "Installed worker controlled fixture", error: error instanceof Error ? error.stack : String(error), requests, events: await events(), logs }, null, 2));
    throw error;
  }
  finally {
    const cleanupErrors: unknown[] = [];
    for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (error) { cleanupErrors.push(error); }
    for (const event of await events()) if (event.kind === "daemon-start" && event.pid !== undefined) {
      try {
        const environment = await readFile(`/proc/${event.pid}/environ`, "utf8");
        if (!environment.split("\0").includes(`FIXTURE_EVENTS=${eventsFile}`)) throw new Error("The fixture daemon PID was reused; its process group was retained.");
        process.kill(-event.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT"))) cleanupErrors.push(error);
      }
    }
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined || ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? resolve() : reject(error)); server.closeAllConnections(); }).catch((error: unknown) => { cleanupErrors.push(error); });
    try { await installed?.cleanup(); } catch (error) { cleanupErrors.push(error); }
    try { await rm(home, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length !== 0) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], "Installed worker fixture or cleanup failed.");
  }
});
