import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import crossSpawn from "cross-spawn";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Project, Task, UpdateWorkerClaimInput, WorkerClaimDescriptor } from "../../src/api/types.js";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const primary = path.basename(path.dirname(workspace)) === ".worktrees" ? path.resolve(workspace, "../..") : workspace;
const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const time = "2026-10-27T00:00:00Z";
type Row = { project_id: string; task_id: string; claim_id: string; status: string; agent: string; session_id: string | null };
type Event = { kind: string; timestamp: number; pid?: number; taskId?: string; text?: string; row?: Row; projectCount?: number; argv?: string[]; message?: string; code?: string };
type FixtureTask = { -readonly [Key in keyof Task]: Task[Key] };

const daemon = String.raw`#!/usr/bin/env node
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
if(process.argv.includes('--version')){process.stdout.write('herdr 0.9.5\n');process.exit(0);}
const require=createRequire(import.meta.url),Database=require(process.env.FIXTURE_SQLITE),events=process.env.FIXTURE_EVENTS;
const event=async(value)=>appendFile(events,JSON.stringify({timestamp:Date.now(),...value})+'\n');
const socketError=error=>{if(error.code==='ECONNRESET'||error.code==='EPIPE'){void event({kind:'peer-disconnect',code:error.code});return;}throw error;};
const record=async(kind,taskId,extra={})=>{const sql=new Database(path.join(process.env.HOME,'.daynight','worker','state.sqlite'),{readonly:true});try{await event({kind,taskId,row:sql.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId),projectCount:sql.prepare('SELECT count(*) AS count FROM projects').get().count,...extra});}finally{sql.close();}};
const directory=path.join(process.env.XDG_CONFIG_HOME,'herdr','sessions','w');await mkdir(directory,{recursive:true});
const workspaces=[],panes=[],agents=[],tabs=[],shells=new Map(),children=new Map(),nativeArguments=new Map();let next=0;
const clone=value=>JSON.parse(JSON.stringify(value));
const snapshot=()=>({workspaces:clone(workspaces),panes:clone(panes),agents:clone(agents),tabs:clone(tabs)});
const owner=pane=>JSON.parse(workspaces.find(workspace=>workspace.workspace_id===pane.workspace_id).label.slice('daynight:'.length));
const processChild=async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});return child;};
const closeChild=async child=>{if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await closed;}};
const stop=async pane=>{const identity=owner(pane),native=children.get(pane.pane_id),shell=shells.get(pane.pane_id);await closeChild(native);await closeChild(shell);if(native)await event({kind:'native-stop',taskId:identity.taskId,pid:native.pid});children.delete(pane.pane_id);shells.delete(pane.pane_id);nativeArguments.delete(pane.pane_id);};
const sockets=new Set();let shutting=false;
const api=createServer(socket=>{socket.on('error',socketError);sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let input='';socket.on('data',async chunk=>{input+=chunk.toString();const end=input.indexOf('\n');if(end<0)return;const request=JSON.parse(input.slice(0,end));input='';const p=request.params;let result;
try{switch(request.method){
case 'ping':result={type:'pong',version:'0.9.5',protocol:22,capabilities:{detached_server_daemon:true}};break;
case 'session.snapshot':result={type:'session_snapshot',snapshot:snapshot()};break;
case 'integration.list':result={type:'integration_list',integrations:[{target:'codex',state:'current'}]};break;
case 'workspace.create':{const id=String(++next),workspace={workspace_id:'w'+id,label:p.label},tab={workspace_id:workspace.workspace_id,tab_id:'tab'+id},pane={workspace_id:workspace.workspace_id,tab_id:tab.tab_id,pane_id:'p'+id,terminal_id:'t'+id,cwd:p.cwd,agent_status:'idle',launch_pending:false,interactive_ready:false};workspaces.push(workspace);panes.push(pane);tabs.push(tab);const shell=await processChild();shells.set(pane.pane_id,shell);await record('workspace',owner(pane).taskId,{pid:shell.pid});result={type:'workspace_created',workspace,root_pane:pane,tab};break;}
case 'agent.start':{const pane=panes.find(item=>item.pane_id===p.pane_id),child=await processChild();children.set(p.pane_id,child);const agent={...pane,agent:p.kind,name:p.name,agent_status:'idle',interactive_ready:true,launch_pending:false,state_change_seq:1,completion_seq:0};agents.push(agent);const argv=[p.kind,...p.args];nativeArguments.set(p.pane_id,argv);await record('native-start',owner(pane).taskId,{argv,pid:child.pid});result={type:'agent_started',agent,argv};break;}
case 'agent.read':{if(p.source!=='visible'||p.format!=='text'||p.strip_ansi!==true)throw new Error('Unexpected input-surface read options');const pane=panes.find(item=>item.pane_id===p.target),agent=agents.find(item=>item.pane_id===p.target),argv=nativeArguments.get(p.target);if(!pane||!agent||!argv)throw new Error('Read requires the original running fixture agent');const modelIndex=argv.indexOf('--model'),model=modelIndex<0?'default':argv[modelIndex+1];const text='  >_ OpenAI Codex (v0.164.0)\n\n› Ask Codex to do anything\n\n  '+model+' default · '+pane.cwd+'\n';result={type:'pane_read',read:{pane_id:pane.pane_id,workspace_id:pane.workspace_id,tab_id:pane.tab_id,source:'visible',format:'text',text,revision:0,truncated:false}};break;}
case 'agent.prompt':{const agent=agents.find(item=>item.pane_id===p.target),pane=panes.find(item=>item.pane_id===p.target),receipt=clone(agent),identity=owner(pane);await event({kind:'prompt',taskId:identity.taskId,text:p.text});if(!agent.agent_session){const argv=nativeArguments.get(p.target),resumeIndex=argv.indexOf('resume'),id=resumeIndex<0?randomUUID():argv[resumeIndex+1];agent.agent_session={source:'herdr:codex',agent:'codex',kind:'id',value:id};const history=path.join(process.env.CODEX_HOME,'sessions');await mkdir(history,{recursive:true});await writeFile(path.join(history,'rollout-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:pane.cwd}})+'\n');}agent.state_change_seq+=2;agent.completion_seq+=1;agent.agent_status='idle';result={type:'agent_prompted',agent:receipt};break;}
case 'pane.process_info':{const pane=panes.find(item=>item.pane_id===p.pane_id),native=children.get(p.pane_id),shell=shells.get(p.pane_id),argv=nativeArguments.get(p.pane_id);if(!shell)throw new Error('Missing fixture task shell');result={type:'pane_process_info',process_info:{pane_id:p.pane_id,shell_pid:shell.pid,foreground_process_group_id:native?native.pid:shell.pid,foreground_processes:native?[{pid:native.pid,name:'codex',argv0:'codex',argv:[...argv],cwd:pane.cwd}]:[]}};break;}
case 'workspace.close':{const workspace=workspaces.find(item=>item.workspace_id===p.workspace_id),taskId=JSON.parse(workspace.label.slice('daynight:'.length)).taskId;for(const pane of panes.filter(item=>item.workspace_id===p.workspace_id))await stop(pane);for(const items of [workspaces,panes,agents,tabs])for(let i=items.length-1;i>=0;i--)if(items[i].workspace_id===p.workspace_id)items.splice(i,1);await event({kind:'workspace-close',taskId});result={type:'ok'};break;}
case 'server.stop':result={type:'ok'};if(!shutting){shutting=true;setTimeout(async()=>{for(const pane of panes)await stop(pane);for(const item of sockets)item.destroy();api.close();client.close();await event({kind:'daemon-stop',pid:process.pid});process.exit(0);},10);}break;
default:throw new Error('Unexpected fixture method '+request.method);
}socket.end(JSON.stringify({id:request.id,result})+'\n');}catch(error){await event({kind:'fixture-error',message:error.stack});socket.end(JSON.stringify({id:request.id,error:{code:'fixture_error',message:error.message}})+'\n');}
});});
const client=createServer(socket=>{socket.on('error',socketError);socket.end();});await new Promise(resolve=>api.listen(path.join(directory,'herdr.sock'),resolve));await new Promise(resolve=>client.listen(path.join(directory,'herdr-client.sock'),resolve));await event({kind:'daemon-start',pid:process.pid});
`;

const metadata = String.raw`#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes('--version'))process.stdout.write('codex-cli 0.164.0\n');
else if(args.includes('--help'))process.stdout.write('--no-daemon\n');
else if(args.includes('features'))process.stdout.write('hooks stable true\n');
else throw new Error('Only metadata commands are permitted in this fixture');
`;

const fixtureProcessAlive = async (pid: number): Promise<boolean> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3) !== "Z";
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
};

const cleanupFixtureProcesses = async (observed: readonly Event[], eventsFile: string): Promise<{ pid: number; outcome: "absent" | "stopped" }[]> => {
  const pids = new Set(observed.filter((entry) => ["workspace", "native-start", "daemon-start"].includes(entry.kind) && entry.pid !== undefined).map((entry) => entry.pid!));
  const result: { pid: number; outcome: "absent" | "stopped" }[] = [];
  for (const pid of pids) {
    if (!await fixtureProcessAlive(pid)) { result.push({ pid, outcome: "absent" }); continue; }
    let environment: string;
    try { environment = await readFile(`/proc/${pid}/environ`, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { result.push({ pid, outcome: "absent" }); continue; } throw error; }
    if (!environment.split("\0").includes(`FIXTURE_EVENTS=${eventsFile}`)) throw new Error(`The fixture PID ${pid} was reused; the unrelated process was retained.`);
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    const deadline = Date.now() + 2_000;
    while (await fixtureProcessAlive(pid)) {
      if (Date.now() >= deadline) throw new Error(`The owned fixture process ${pid} did not exit.`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    result.push({ pid, outcome: "stopped" });
  }
  return result;
};

it.skipIf(process.platform !== "linux")("keeps the fixture daemon alive when an RPC peer cancels its response", async () => {
  const temporary = path.join(primary, ".tmp");
  await mkdir(temporary, { recursive: true });
  const home = await mkdtemp(path.join(temporary, "wreset"));
  const eventsFile = path.join(home, "events.jsonl");
  const configHome = path.join(home, "c");
  const endpoint = path.join(configHome, "herdr/sessions/w/herdr.sock");
  const source = path.join(home, "herdr.mjs");
  const database = path.join(home, ".daynight/worker/state.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const sql = new Database(database);
  sql.exec("CREATE TABLE projects(project_id TEXT,repo_url TEXT,local_path TEXT);CREATE TABLE tasks(project_id TEXT,task_id TEXT,claim_id TEXT,status TEXT,agent TEXT,session_id TEXT);INSERT INTO projects VALUES('p','r','l');INSERT INTO tasks VALUES('p','t','c','active','codex',NULL)");
  sql.close();
  await writeFile(source, daemon);
  const child = spawn(process.execPath, [source], { detached: true, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, FIXTURE_EVENTS: eventsFile, FIXTURE_SQLITE: createRequire(import.meta.url).resolve("better-sqlite3") }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (value: Buffer) => { stderr += value.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const call = (method: string, params: Record<string, unknown>, cancel = false): Promise<string> => new Promise((resolve, reject) => {
    const socket = new Socket(); let response = "";
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => { response += chunk.toString(); });
    socket.on("end", () => resolve(response));
    socket.connect(endpoint, () => { socket.write(`${JSON.stringify({ id: "transport", method, params })}\n`, () => { if (cancel) { socket.destroy(); resolve(""); } }); });
  });
  const readEvents = async (): Promise<Event[]> => {
    try {
      const source = await readFile(eventsFile, "utf8");
      return source.slice(0, source.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
    }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  };
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(endpoint)) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`Fixture startup failed: ${stderr}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await call("workspace.create", { label: `daynight:${JSON.stringify({ taskId: "t", padding: "x".repeat(1_000_000) })}`, cwd: home });
    await call("session.snapshot", {}, true);
    while (!(await readEvents()).some((event) => event.kind === "peer-disconnect")) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`Cancelled RPC terminated the fixture: ${stderr}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(await call("ping", {}))).toMatchObject({ result: { type: "pong" } });
    expect((await readEvents()).filter((event) => event.kind === "peer-disconnect").map((event) => event.code)).toEqual([expect.stringMatching(/^(EPIPE|ECONNRESET)$/)]);
    expect(child.exitCode).toBeNull();
    expect(stderr).toBe("");
  } finally {
    const observed = await readEvents();
    if (child.pid !== undefined) observed.push({ kind: "daemon-start", pid: child.pid, timestamp: Date.now() });
    await cleanupFixtureProcesses(observed, eventsFile);
    await closed;
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux").each(["resume", "null-session", "empty-database", "inventory-failure"] as const)("runs the installed minimal worker through %s", async (scenario) => {
  const scratch = path.join(primary, ".tmp");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, "w"));
  const eventsFile = path.join(home, "events.jsonl");
  const databaseFile = path.join(home, ".daynight/worker/state.sqlite");
  const evidenceFile = path.join(workspace, ".tmp", `installed-worker-${scenario}.json`);
  const cleanupEvidenceFile = path.join(workspace, ".tmp", `installed-worker-${scenario}-cleanup.json`);
  const logs: string[] = [];
  const requests: { method: string; path: string; taskId?: string }[] = [];
  const inventoryResponses: { projectId: string; itemCount: number; status: number; mappedProjectCount: number }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let installed: Awaited<ReturnType<typeof createInstalledCli>> | undefined;
  let failure: unknown;
  let failInventory = false;
  const projects: Project[] = [1, 2].map((number) => ({ id: uuid(number), name: `Repo ${number}`, repoUrl: `https://git.example/worker/repo-${number}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }));
  const tasks: FixtureTask[] = projects.map((project, index) => ({ id: uuid(index + 10), projectId: project.id, title: `Managed ${index + 1}`, description: "Fixture task", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: true, requiredPlatform: "linux", version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true }));
  const send = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "content-type": "application/json", ...(status >= 200 && status < 300 ? { "Daynight-User-ID": uuid(100) } : {}) }); response.end(stringifyApiJson(value)); };
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
      if (request.headers.authorization !== "Bearer worker-fixture-token") { send(response, { error: { code: "unauthorized", message: "Fixture authentication mismatch", requestId: "worker-auth-fixture" } }, 401); return; }
      requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, ...(task === undefined ? {} : { taskId: task.id }) });
      if (url.pathname === "/api/v1/me" && request.method === "GET") { send(response, { id: uuid(100), email: null, emailVerified: null, name: null, avatarUrl: null }); return; }
      if (url.pathname === "/api/v1/projects" && request.method === "GET") { send(response, { items: projects, nextCursor: null }); return; }
      if (project !== undefined && parts.length === 5 && request.method === "GET") { send(response, project); return; }
      if (task !== undefined && parts.length === 7 && request.method === "GET") { send(response, task); return; }
      if (project !== undefined && parts.length === 6 && request.method === "GET") {
        const inventory = url.searchParams.get("workerId");
        if (inventory !== null && failInventory) {
          inventoryResponses.push({ projectId: project.id, itemCount: 0, status: 500, mappedProjectCount: 2 });
          send(response, { error: { code: "internal_error", message: "Injected unavailable inventory", requestId: "worker-inventory-fault" } }, 500); return;
        }
        const items = tasks.filter((item) => item.projectId === project.id && (inventory === null ? item.ready && item.allowAgents : item.properties.worker?.state === "active" && item.properties.worker.workerId === inventory && item.properties.worker.userId === uuid(100)));
        if (inventory !== null) {
          const sql = new Database(databaseFile, { readonly: true });
          try { inventoryResponses.push({ projectId: project.id, itemCount: items.length, status: 200, mappedProjectCount: (sql.prepare("SELECT count(*) AS count FROM projects").get() as { count: number }).count }); }
          finally { sql.close(); }
        }
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
        if (input.version !== task.version || task.properties.worker?.state !== "active" || task.properties.worker.claimId !== input.claimId || task.properties.worker.userId !== uuid(100)) { refusal(response); return; }
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
  const row = (taskId: string): Row | undefined => {
    const db = new Database(databaseFile, { readonly: true });
    try { return db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Row | undefined; }
    finally { db.close(); }
  };
  const waitFor = async (label: string, condition: () => boolean | Promise<boolean>, timeout = 20_000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (!await condition()) {
      if (Date.now() >= deadline) throw new Error(`Installed worker did not reach ${label}.\n${logs.join("")}\n${JSON.stringify(await events())}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  const expectExit = async (closed: Promise<number | null>, expectedCode: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Installed worker shutdown timed out.\n${logs.join("")}`)), 20_000); })]);
      expect(code, logs.join("")).toBe(expectedCode);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const complete = (task: FixtureTask): void => {
    task.status = "done"; task.ready = false; task.completedAt = time; task.version += 1n;
    task.properties = { ...task.properties, worker: { ...task.properties.worker!, state: "completed" } };
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
    const configFile = path.join(home, ".daynight/config.yml");
    await mkdir(path.dirname(configFile));
    await writeFile(configFile, yaml({ serverUrl: `http://127.0.0.1:${address.port}`, serverToken: "worker-fixture-token", worker: { agent: "codex", model: "fixture-model", args: ["--search"], maxConcurrent: 1, pollIntervalMs: 50, repositories: projects.map((project, index) => ({ remote: project.repoUrl, path: repositoryPaths[index], projectId: project.id })) } }));
    const start = () => {
      const child = crossSpawn(installed!.receipt.launcherPath, ["worker", "run"], { cwd: home, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
      child.stdout!.on("data", (value: Buffer) => { logs.push(value.toString()); });
      child.stderr!.on("data", (value: Buffer) => { logs.push(value.toString()); });
      const closed = new Promise<number | null>((resolve, reject) => { child.once("close", (code) => { children.delete(child); resolve(code); }); child.once("error", reject); });
      children.set(child, closed);
      return { child, closed };
    };
    const original = start();
    await waitFor("first native session", async () => (await events()).some((event) => event.kind === "native-start" && event.taskId === tasks[0]!.id) && row(tasks[0]!.id)?.session_id !== undefined && row(tasks[0]!.id)?.session_id !== null);
    const first = tasks[0]!;
    complete(first);
    await waitFor("first cleanup and second native session", () => row(first.id)?.status === "done" && row(tasks[1]!.id)?.session_id !== undefined && row(tasks[1]!.id)?.session_id !== null);
    const second = tasks[1]!;
    const originalSession = row(second.id)!.session_id!;
    const originalClaim = second.properties.worker!.claimId;
    const sentinel = path.join(repositoryPaths[1]!, ".worktrees/daynight", second.id, "uncommitted.txt");
    await writeFile(sentinel, "Keep the original uncommitted task result.\n");
    const sql = new Database(databaseFile, { readonly: true });
    try {
      expect(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "projects" }, { name: "tasks" }]);
      expect((sql.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((column) => column.name)).toEqual(["project_id", "repo_url", "local_path"]);
      expect((sql.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((column) => column.name)).toEqual(["project_id", "task_id", "claim_id", "status", "agent", "session_id"]);
    } finally { sql.close(); }
    let restarted: ReturnType<typeof start> | undefined;
    let restartRequestOffset = requests.length;
    let restartLogOffset = logs.length;
    if (scenario === "inventory-failure") {
      failInventory = true;
      complete(second);
      await waitFor("failed own inventory", () => inventoryResponses.some((response) => response.status === 500));
      const processStarts = (await events()).filter((event) => event.kind === "native-start").length;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(row(second.id)?.status).toBe("active");
      expect(await readFile(sentinel, "utf8")).toBe("Keep the original uncommitted task result.\n");
      expect((await events()).filter((event) => event.kind === "native-start")).toHaveLength(processStarts);
      expect((await events()).some((event) => event.kind === "workspace-close" && event.taskId === second.id)).toBe(false);
      failInventory = false;
      await waitFor("cleanup after a successful complete inventory", () => row(second.id)?.status === "done");
      expect(original.child.kill("SIGINT")).toBe(true);
      await expectExit(original.closed, 0);
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      let running = original;
      if (scenario === "resume") {
        expect(original.child.kill("SIGKILL")).toBe(true);
        expect(await original.closed).toBeNull();
        const reconnectLogOffset = logs.length;
        running = start();
        await waitFor("live native reconnection after worker crash", () => logs.slice(reconnectLogOffset).join("").includes("Connected to the existing agent"));
        expect((await events()).filter((event) => event.kind === "native-start")).toHaveLength(2);
        expect((await events()).filter((event) => event.kind === "prompt" && event.taskId === second.id && event.text!.includes("Assignment:"))).toHaveLength(1);
        expect(row(second.id)).toMatchObject({ claim_id: originalClaim, session_id: originalSession });
      }
      expect(running.child.kill("SIGINT")).toBe(true);
      await expectExit(running.closed, 0);
      expect(row(second.id)).toMatchObject({ status: "active", claim_id: originalClaim, session_id: originalSession });
      expect(await readFile(sentinel, "utf8")).toBe("Keep the original uncommitted task result.\n");
      const configuration = parseYaml(await readFile(configFile, "utf8")) as { worker: { model: string } };
      configuration.worker.model = "current-model";
      await writeFile(configFile, yaml(configuration));
      if (scenario === "empty-database") await rm(databaseFile);
      else if (scenario === "null-session") {
        const database = new Database(databaseFile);
        try { expect(database.prepare("UPDATE tasks SET session_id=NULL WHERE task_id=? AND claim_id=?").run(second.id, originalClaim).changes).toBe(1); }
        finally { database.close(); }
      }
      restartRequestOffset = requests.length; restartLogOffset = logs.length;
      restarted = start();
      await waitFor("second task restart", async () => (await events()).filter((event) => event.kind === "native-start" && event.taskId === second.id).length === 2 && row(second.id)?.session_id !== undefined && row(second.id)?.session_id !== null);
      const restartedSession = row(second.id)!.session_id!;
      expect(row(second.id)).toMatchObject({ status: "active", claim_id: originalClaim, agent: "codex" });
      expect(await readFile(sentinel, "utf8")).toBe("Keep the original uncommitted task result.\n");
      const latestStart = (await events()).filter((event) => event.kind === "native-start" && event.taskId === second.id).at(-1)!;
      expect(latestStart.argv).toContain("current-model");
      if (scenario === "resume") {
        expect(restartedSession).toBe(originalSession);
        expect(latestStart.argv).toEqual(["codex", "--no-daemon", "resume", originalSession, "--model", "current-model", "--search"]);
      } else {
        expect(restartedSession).not.toBe(originalSession);
        expect(latestStart.argv).not.toContain("resume");
        expect(logs.slice(restartLogOffset).join("")).toContain("native session ID is missing");
      }
      expect(second.properties.worker!.claimId).toBe(originalClaim);
      expect(requests.slice(restartRequestOffset).some((request) => request.method === "POST")).toBe(false);
      expect(inventoryResponses.filter((response) => response.status === 200).every((response) => response.mappedProjectCount === 2)).toBe(true);
      expect(restarted.child.kill("SIGINT")).toBe(true);
      await expectExit(restarted.closed, 0);
      expect(row(second.id)?.status).toBe("active");
      expect(await readFile(sentinel, "utf8")).toBe("Keep the original uncommitted task result.\n");
    }
    const observed = await events();
    expect(observed.filter((event) => event.kind === "fixture-error")).toEqual([]);
    expect(observed.filter((event) => event.kind === "native-start").map((event) => event.taskId)).toEqual(scenario === "inventory-failure" ? tasks.map((task) => task.id) : [first.id, second.id, second.id]);
    for (const event of observed.filter((entry) => entry.kind === "workspace" || entry.kind === "native-start")) {
      expect(event.row).toMatchObject({ status: "active", agent: "codex" });
      expect(Object.keys(event.row!).sort()).toEqual(["agent", "claim_id", "project_id", "session_id", "status", "task_id"]);
      expect(event.projectCount).toBe(2);
    }
    for (const task of tasks) {
      const assignments = observed.filter((event) => event.kind === "prompt" && event.taskId === task.id && event.text!.includes("Assignment:"));
      expect(assignments).toHaveLength(task === second && scenario !== "inventory-failure" ? 2 : 1);
      const assignment = assignments[0]!.text!;
      expect(assignment).toContain("worker-managed"); expect(assignment).toContain("using-daynight"); expect(assignment).toContain("execute-task-in-managed");
      expect(assignment).toContain("references/execute-task-in-managed.md"); expect(assignment).not.toContain("worker-fixture-token");
      expect(JSON.parse(assignment.split("Assignment:")[1]!)).toMatchObject({ projectId: task.projectId, taskId: task.id, claimId: task.properties.worker!.claimId, workerId: task.properties.worker!.workerId, worktreeId: task.properties.worker!.worktreeId, platform: "linux", nativeSessionId: null, configuration: { agent: "codex", model: "fixture-model", args: ["--search"], recoveryLimit: 3 } });
    }
    expect(observed.filter((event) => event.kind === "daemon-start")).toHaveLength(scenario === "inventory-failure" ? 1 : 2);
    expect(observed.filter((event) => event.kind === "daemon-stop")).toHaveLength(scenario === "inventory-failure" ? 1 : 2);
    expect(observed.filter((event) => event.kind === "native-stop")).toHaveLength(scenario === "inventory-failure" ? 2 : 3);
    expect(observed.filter((event) => event.kind === "workspace-close")).toHaveLength(scenario === "inventory-failure" ? 2 : 3);
    expect(observed.findIndex((event) => event.kind === "native-start" && event.taskId === second.id)).toBeGreaterThan(observed.findIndex((event) => event.kind === "workspace-close" && event.taskId === first.id));
    expect(requests.filter((request) => request.method === "POST").map((request) => request.taskId)).toEqual(tasks.map((task) => task.id));
    await expect(readFile(path.join(repositoryPaths[0]!, ".worktrees/daynight", first.id, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(row(second.id)?.session_id).toMatch(/^[0-9a-f-]{36}$/);
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, JSON.stringify({ outcome: "passed", scenario, method: "Installed public launcher with real Git/SQLite/HTTP and controlled Herdr/Codex metadata and real task-process substitutes", nativeAgentExecution: false, receipt: installed.receipt, requests, inventoryResponses, events: observed, first: row(first.id), second: row(second.id), limitations: ["Linux controlled fixture only", "Does not establish model execution or native Herdr qualification", "Two-repository progression does not establish sustained-load fairness"] }, null, 2));
  } catch (error) {
    failure = error;
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    const herdrStderr = await readFile(path.join(home, ".daynight/worker/logs/herdr.stderr.log"), "utf8").catch((readError: unknown) => {
      if (readError instanceof Error && "code" in readError && readError.code === "ENOENT") return null;
      throw readError;
    });
    await writeFile(evidenceFile, JSON.stringify({ outcome: "failed", scenario, error: error instanceof Error ? error.stack : String(error), requests, events: await events(), logs, herdrStderr }, null, 2));
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (error) { cleanupErrors.push(error); }
    const observed = await events();
    let processes: Awaited<ReturnType<typeof cleanupFixtureProcesses>> = [];
    try { processes = await cleanupFixtureProcesses(observed, eventsFile); }
    catch (error) { cleanupErrors.push(error); }
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined || ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? resolve() : reject(error)); server.closeAllConnections(); }).catch((error: unknown) => { cleanupErrors.push(error); });
    try { await installed?.cleanup(); } catch (error) { cleanupErrors.push(error); }
    try { await rm(home, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    await mkdir(path.dirname(cleanupEvidenceFile), { recursive: true });
    await writeFile(cleanupEvidenceFile, JSON.stringify({ outcome: cleanupErrors.length === 0 ? "passed" : "failed", scenario, homeRemoved: !existsSync(home), installedArtifactRemoved: installed === undefined ? null : !existsSync(installed.receipt.root), processes, errors: cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)) }, null, 2));
    if (cleanupErrors.length !== 0) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], "Installed worker fixture or cleanup failed.");
  }
});
