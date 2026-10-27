import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
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
import type { CleanupState } from "../../src/commands/worker/types.js";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const primary = path.basename(path.dirname(workspace)) === ".worktrees" ? path.resolve(workspace, "../..") : workspace;
const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const time = "2026-10-26T00:00:00Z";
type Event = { kind: string; timestamp: number; pid?: number; taskId?: string; text?: string; row?: { status: string; configuration: string; userId: string | null }; projectCount?: number; binding?: unknown; argv?: string[] };
type FixtureTask = { -readonly [Key in keyof Task]: Task[Key] };

const daemon = String.raw`#!/usr/bin/env node
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write('herdr 0.9.5\n'); process.exit(0); }
const require=createRequire(import.meta.url), Database=require(process.env.FIXTURE_SQLITE);
const events=process.env.FIXTURE_EVENTS;
const event=async(value)=>appendFile(events,JSON.stringify({timestamp:Date.now(),...value})+'\n');
const cleanupGate=async(taskId,prompt)=>{if(taskId!==process.env.FIXTURE_HELD_CLEANUP_TASK||prompt.includes('Assignment:'))return;await event({kind:'cleanup-ack-held',taskId});while(true){try{await access(process.env.FIXTURE_CLEANUP_GATE);break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,25));}await event({kind:'cleanup-ack-released',taskId});};
const db=()=>new Database(path.join(process.env.HOME,'.daynight','worker','state.sqlite'),{readonly:true});
const record=async(kind,taskId,extra={})=>{const sql=db();try{await event({kind,taskId,row:sql.prepare('SELECT status,configuration,user_id AS userId FROM tasks WHERE task_id=?').get(taskId),projectCount:sql.prepare('SELECT count(*) AS count FROM projects').get().count,...extra});}finally{sql.close();}};
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
case 'agent.prompt':{const agent=agents.find(item=>item.pane_id===p.target),pane=panes.find(item=>item.pane_id===p.target);const receipt=clone(agent);const identity=owner(pane);await event({kind:'prompt',taskId:identity.taskId,text:p.text});await cleanupGate(identity.taskId,p.text);if(!agent.agent_session){const id='00000000-0000-4000-8000-'+String(++next).padStart(12,'0');agent.agent_session={source:'herdr:codex',agent:'codex',kind:'id',value:id};const history=path.join(process.env.CODEX_HOME,'sessions');await mkdir(history,{recursive:true});await writeFile(path.join(history,'rollout-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:pane.cwd}})+'\n');}agent.state_change_seq+=2;agent.completion_seq+=1;agent.agent_status='idle';result={type:'agent_prompted',agent:receipt};break;}
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

it.skipIf(process.platform !== "linux").each(["startup-interrupt", "committed-cleanup-deadline", "independent-cleanup-deadlines", "account-scope", "origin-cleanup", "origin-shutdown", "empty-repositories-cleanup-deadline"] as const)("runs the installed worker through claim, managed launch and %s", async (scenario) => {
  const accountScope = scenario === "account-scope";
  const originCleanup = scenario === "origin-cleanup";
  const originShutdown = scenario === "origin-shutdown";
  const originChanged = originCleanup || originShutdown;
  const emptyRepositories = scenario === "empty-repositories-cleanup-deadline";
  const parallelDeadlines = scenario === "independent-cleanup-deadlines";
  const committedDeadline = scenario === "committed-cleanup-deadline" || parallelDeadlines || originCleanup || emptyRepositories;
  const scratch = path.join(primary, ".tmp");
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, "w"));
  const eventsFile = path.join(home, "events.jsonl");
  const databaseFile = path.join(home, ".daynight/worker/state.sqlite");
  const evidenceName = originChanged || emptyRepositories ? `installed-worker-${scenario}` : accountScope ? "installed-worker-account-scope" : parallelDeadlines ? "installed-worker-independent-deadlines" : committedDeadline ? "installed-worker-committed-deadline" : "installed-worker-acceptance";
  const evidenceFile = path.join(workspace, ".tmp", `${evidenceName}.json`);
  const cleanupEvidenceFile = path.join(workspace, ".tmp", scenario === "startup-interrupt" ? "installed-worker-cleanup.json" : `${evidenceName}-cleanup.json`);
  const cleanupGateFile = path.join(home, "cleanup-ack-gate");
  const logs: string[] = [];
  const requests: { method: string; path: string; userId: string; serverOrigin: string; taskId?: string }[] = [];
  const inventoryResponses: { userId: string; projectId: string; itemCount: number; status: number }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let installed: Awaited<ReturnType<typeof createInstalledCli>> | undefined;
  let failure: unknown;
  let holdProjectReads = false;
  let heldProjectReads = 0;
  const heldProjectInventories: ServerResponse[] = [];
  let holdProjectInventory = false;
  let guideWitness: { configuration: string; discoveryHeldAt: number; cleanupCompletedWhileHeldAt: number | null; discoveryFailedAt: number | null } | null = null;
  let failInventoryReads = false;
  let seededCleanup: CleanupState | null = null;
  let peerCleanup: CleanupState | null = null;
  let cleanupCompletedAt: number | null = null;
  let peerPendingWitness: { timestamp: number; status: string; input: string; nativeProcessIds: number[] } | null = null;
  let principal = uuid(100);
  let accountScopeWitness: { originalUserId: string | null; switchedUserId: string; originalClaimId: string; originalConfiguration: string; originalResources: string; sentinel: string; nativeStartsBeforeSwitch: number; successfulEmptyInventoryProjects: string[] } | null = null;
  let sourceOrigin = "";
  let sourceServerClosed = false;
  let alternateServer: ReturnType<typeof createServer> | undefined;
  let originScopeWitness: { originalOrigin: string; currentOrigin: string; sourceRequestsAtClosure: number; originalResources: string; originalConfiguration: string; preShutdownNativeProcessIds: number[]; preShutdownStatus: string | null; preShutdownCleanup: string | null } | null = null;
  const projects: Project[] = [1, 2].map((number) => ({ id: uuid(number), name: `Repo ${number}`, repoUrl: `https://git.example/worker/repo-${number}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }));
  const alternateProject: Project = { ...projects[0]!, id: uuid(300), name: "Current-origin inert Project" };
  const tasks: FixtureTask[] = projects.map((project, index) => ({ id: uuid(index + 10), projectId: project.id, title: `Managed ${index + 1}`, description: "Fixture task", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: true, requiredPlatform: "linux", version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true }));
  const send = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "content-type": "application/json", ...(status >= 200 && status < 300 ? { "Daynight-User-ID": principal } : {}) }); response.end(stringifyApiJson(value)); };
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
      const authenticatedUser = request.headers.authorization === "Bearer worker-fixture-token" ? uuid(100) : request.headers.authorization === "Bearer worker-fixture-token-b" ? uuid(101) : null;
      if (authenticatedUser !== principal) { send(response, { error: { code: "unauthorized", message: "Fixture authentication mismatch", requestId: "worker-auth-fixture" } }, 401); return; }
      requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, userId: authenticatedUser, serverOrigin: sourceOrigin, ...(task === undefined ? {} : { taskId: task.id }) });
      if (url.pathname === "/api/v1/me" && request.method === "GET") { send(response, { id: principal, email: null, emailVerified: null, name: null, avatarUrl: null }); return; }
      if (url.pathname === "/api/v1/projects" && request.method === "GET" && holdProjectInventory) {
        guideWitness!.discoveryHeldAt = Date.now();
        heldProjectInventories.push(response);
        return;
      }
      if (project !== undefined && parts.length === 5 && request.method === "GET") {
        if (holdProjectReads) { heldProjectReads++; return; }
        send(response, project); return;
      }
      if (project !== undefined && parts.length === 6 && request.method === "GET") {
        const inventory = url.searchParams.get("workerId");
        if (inventory !== null && failInventoryReads) { send(response, { error: { code: "internal_error", message: "Injected unavailable inventory", requestId: "worker-inventory-fault" } }, 500); return; }
        const items = tasks.filter((item) => item.projectId === project.id && (inventory === null ? item.ready && item.allowAgents : item.properties.worker?.state === "active" && item.properties.worker.workerId === inventory && item.properties.worker.userId === principal));
        if (inventory !== null) inventoryResponses.push({ userId: principal, projectId: project.id, itemCount: items.length, status: 200 });
        send(response, { items, nextCursor: null }); return;
      }
      if (task !== undefined && parts[7] === "worker-claim" && request.method === "POST") {
        const input = body as WorkerClaimDescriptor & { version: bigint };
        if (input.version !== task.version || !task.ready || task.properties.worker?.state === "active") { refusal(response); return; }
        task.properties = { ...task.properties, worker: { claimId: input.claimId, workerId: input.workerId, machine: input.machine, platform: input.platform, agent: input.agent, worktreeId: input.worktreeId, state: "active", userId: principal, phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: time } };
        task.status = "in_progress"; task.ready = false; task.startedAt = time; task.version += 1n;
        send(response, task); return;
      }
      if (task !== undefined && parts[7] === "worker-claim" && request.method === "PATCH") {
        const input = body as UpdateWorkerClaimInput;
        if (input.version !== task.version || task.properties.worker?.state !== "active" || task.properties.worker.claimId !== input.claimId || task.properties.worker.userId !== principal) { refusal(response); return; }
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
    try { return db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as { status: string; server_origin: string; user_id: string | null; configuration: string; recovery: string; native_execution: string; cleanup: string; resources: string }; }
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([closed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Installed worker shutdown timed out.\n${logs.join("")}`)), 20_000); })]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    expect(code, logs.join("")).toBe(expectedCode);
  };
  try {
    installed = await createInstalledCli();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing worker fixture address.");
    sourceOrigin = `http://127.0.0.1:${address.port}`;
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
    if (parallelDeadlines) Object.assign(environment, { FIXTURE_HELD_CLEANUP_TASK: tasks[1]!.id, FIXTURE_CLEANUP_GATE: cleanupGateFile });
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
    await writeFile(path.join(home, ".daynight/config.yml"), yaml({ serverUrl: `http://127.0.0.1:${address.port}`, serverToken: "worker-fixture-token", worker: { agent: "codex", model: "fixture-model", args: ["--search"], maxConcurrent: parallelDeadlines ? 2 : 1, pollIntervalMs: 50, repositories: projects.map((project, index) => ({ remote: project.repoUrl, path: repositoryPaths[index], projectId: project.id })) } }));
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
    if (!parallelDeadlines) {
      first.status = "done"; first.ready = false; first.completedAt = time; first.version += 1n;
      first.properties = { ...first.properties, worker: { ...first.properties.worker!, state: "completed" } };
    }
    await waitFor("second managed prompt", async () => (parallelDeadlines || row(first.id).status === "done") && (await events()).some((event) => event.kind === "prompt" && event.taskId === tasks[1]!.id));
    await waitFor("second prompt and original native process journal", () => {
      const execution = JSON.parse(row(tasks[1]!.id).native_execution);
      return execution.promptSubmission === "submitted" && execution.stopObservation !== null;
    });
    if (parallelDeadlines) await waitFor("first original native process journal", () => JSON.parse(row(first.id).native_execution).stopObservation !== null);
    const sentinelFile = path.join(repositoryPaths[1]!, ".worktrees/daynight", tasks[1]!.id, "uncommitted-a.txt");
    if (accountScope || originShutdown) await writeFile(sentinelFile, "Uncommitted result belonging to authenticated user A.\n");
    if (accountScope) {
      expect(originalWorker.child.kill("SIGINT")).toBe(true);
      await expectExit(originalWorker.closed, 0);
      const original = row(tasks[1]!.id);
      expect(original.user_id).toBe(uuid(100));
      expect(original.status).toBe("active");
      expect(JSON.parse(original.cleanup)).toMatchObject({ kind: "shutdown", agentStopped: true, workspaceClosed: true, worktreeDeleted: false });
      accountScopeWitness = { originalUserId: original.user_id, switchedUserId: uuid(101), originalClaimId: tasks[1]!.properties.worker!.claimId, originalConfiguration: original.configuration, originalResources: original.resources, sentinel: await readFile(sentinelFile, "utf8"), nativeStartsBeforeSwitch: (await events()).filter((event) => event.kind === "native-start").length, successfulEmptyInventoryProjects: [] };
      const configFile = path.join(home, ".daynight/config.yml");
      const configuration = parseYaml(await readFile(configFile, "utf8")) as { serverToken: string };
      configuration.serverToken = "worker-fixture-token-b";
      await writeFile(configFile, yaml(configuration));
      principal = uuid(101);
    } else {
      expect(originalWorker.child.kill("SIGKILL")).toBe(true);
      expect(await originalWorker.closed).toBeNull();
    }
    expect((await events()).filter((event) => event.kind === "daemon-stop")).toHaveLength(accountScope ? 1 : 0);
    holdProjectReads = !accountScope && !originChanged && !emptyRepositories;
    const restartRequestOffset = requests.length;
    if (committedDeadline) {
      const deadline = Date.now() + 2_000;
      seededCleanup = { kind: "terminal", startedAt: deadline - 600_000, deadline, input: "unknown", baseline: null, result: null, error: "Controlled SQL injection of a previously committed terminal intent with an uncertain cleanup input.", agentStopped: false, workspaceClosed: false, worktreeDeleted: false };
      if (parallelDeadlines) peerCleanup = { ...seededCleanup, startedAt: deadline - 582_000, deadline: deadline + 18_000, input: "not-submitted", error: null };
      const sql = new Database(databaseFile);
      try {
        const target = parallelDeadlines ? first : tasks[1]!;
        expect(sql.prepare("UPDATE tasks SET cleanup=? WHERE task_id=? AND claim_id=? AND status='active'").run(JSON.stringify(seededCleanup), target.id, target.properties.worker!.claimId).changes).toBe(1);
        if (parallelDeadlines) expect(sql.prepare("UPDATE tasks SET cleanup=? WHERE task_id=? AND claim_id=? AND status='active'").run(JSON.stringify(peerCleanup), tasks[1]!.id, tasks[1]!.properties.worker!.claimId).changes).toBe(1);
      }
      finally { sql.close(); }
      const configFile = path.join(home, ".daynight/config.yml");
      const configuration = parseYaml(await readFile(configFile, "utf8")) as { worker: { pollIntervalMs: number } };
      configuration.worker.pollIntervalMs = 3_600_000;
      await writeFile(configFile, yaml(configuration));
      failInventoryReads = true;
      for (const task of parallelDeadlines ? tasks : [tasks[1]!]) {
        task.status = "done"; task.ready = false; task.completedAt = time; task.version += 1n;
        task.properties = { ...task.properties, worker: { ...task.properties.worker!, state: "completed" } };
      }
    }
    if (emptyRepositories) {
      const configFile = path.join(home, ".daynight/config.yml");
      const configuration = parseYaml(await readFile(configFile, "utf8")) as { worker: { repositories: unknown[] } };
      configuration.worker.repositories = [];
      const source = yaml(configuration);
      await writeFile(configFile, source);
      holdProjectInventory = true;
      guideWitness = { configuration: source, discoveryHeldAt: 0, cleanupCompletedWhileHeldAt: null, discoveryFailedAt: null };
    }
    if (originChanged) {
      const original = row(tasks[1]!.id);
      expect(original.server_origin).toBe(sourceOrigin);
      expect(original.user_id).toBe(uuid(100));
      alternateServer = createServer((request, response) => {
        const url = new URL(request.url!, "http://localhost");
        const address = alternateServer!.address();
        if (address === null || typeof address === "string") throw new Error("Missing alternate worker origin.");
        requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, userId: principal, serverOrigin: `http://127.0.0.1:${address.port}` });
        if (request.headers.authorization === "Bearer worker-fixture-token" && request.method === "GET") {
          if (url.pathname === "/api/v1/me") { send(response, { id: uuid(100), email: null, emailVerified: null, name: null, avatarUrl: null }); return; }
          if (url.pathname === `/api/v1/projects/${alternateProject.id}`) { send(response, alternateProject); return; }
          if (url.pathname === `/api/v1/projects/${alternateProject.id}/tasks`) {
            if (url.searchParams.has("workerId")) inventoryResponses.push({ userId: principal, projectId: alternateProject.id, itemCount: 0, status: 200 });
            send(response, { items: [], nextCursor: null });
            return;
          }
        }
        logs.push(`Unexpected alternate-origin request ${request.method} ${url.pathname}\n`);
        send(response, { error: { code: "forbidden", message: "Alternate origin only provides current identity and its inert Project", requestId: "worker-origin-fixture" } }, 403);
      });
      await new Promise<void>((resolve) => alternateServer!.listen(0, "127.0.0.1", resolve));
      const address = alternateServer.address();
      if (address === null || typeof address === "string") throw new Error("Missing alternate worker origin.");
      const alternateOrigin = `http://127.0.0.1:${address.port}`;
      expect(alternateOrigin).not.toBe(sourceOrigin);
      const configFile = path.join(home, ".daynight/config.yml");
      const configuration = parseYaml(await readFile(configFile, "utf8")) as { serverUrl: string; worker: { pollIntervalMs: number; repositories: unknown[] } };
      configuration.serverUrl = alternateOrigin;
      configuration.worker.pollIntervalMs = 3_600_000;
      configuration.worker.repositories = [{ remote: alternateProject.repoUrl, path: repositoryPaths[0], projectId: alternateProject.id }];
      await writeFile(configFile, yaml(configuration));
      await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
      sourceServerClosed = true;
      originScopeWitness = { originalOrigin: sourceOrigin, currentOrigin: alternateOrigin, sourceRequestsAtClosure: requests.filter((request) => request.serverOrigin === sourceOrigin).length, originalResources: original.resources, originalConfiguration: original.configuration, preShutdownNativeProcessIds: [], preShutdownStatus: null, preShutdownCleanup: null };
    }
    const restartLogOffset = logs.length;
    const restartedWorker = start();
    if (accountScope) {
      await waitFor("successful empty user B inventory and original-owner scope pause", () => new Set(inventoryResponses.filter((response) => response.userId === principal && response.status === 200 && response.itemCount === 0).map((response) => response.projectId)).size === 2 && logs.some((line) => line.includes("scope-paused")));
      accountScopeWitness!.successfulEmptyInventoryProjects = [...new Set(inventoryResponses.filter((response) => response.userId === principal && response.status === 200 && response.itemCount === 0).map((response) => response.projectId))];
      const retained = row(tasks[1]!.id);
      expect(retained).toMatchObject({ user_id: uuid(100), status: "active", configuration: accountScopeWitness!.originalConfiguration, resources: accountScopeWitness!.originalResources });
      expect(JSON.parse(retained.recovery).pauseReason).toContain("current authenticated user does not match");
      expect(JSON.parse(retained.cleanup)).toMatchObject({ kind: "shutdown", worktreeDeleted: false });
      expect(await readFile(sentinelFile, "utf8")).toBe(accountScopeWitness!.sentinel);
      expect((await events()).filter((event) => event.kind === "native-start")).toHaveLength(accountScopeWitness!.nativeStartsBeforeSwitch);
      expect(tasks[1]!.properties.worker).toMatchObject({ state: "active", userId: uuid(100), claimId: accountScopeWitness!.originalClaimId });
      expect(requests.slice(restartRequestOffset).every((request) => request.userId === principal && request.method === "GET")).toBe(true);
    } else if (originChanged) {
      await waitFor("new origin identity and successful empty configured project scope", () => requests.some((request) => request.serverOrigin === originScopeWitness!.currentOrigin && request.path === "/api/v1/me") && inventoryResponses.some((response) => response.projectId === alternateProject.id && response.itemCount === 0 && response.status === 200) && logs.slice(restartLogOffset).some((line) => line.includes("Original ready private Herdr session")));
      expect(row(tasks[1]!.id).server_origin).toBe(sourceOrigin);
      expect(requests.filter((request) => request.serverOrigin === sourceOrigin)).toHaveLength(originScopeWitness!.sourceRequestsAtClosure);
      expect(requests.filter((request) => request.serverOrigin === originScopeWitness!.currentOrigin).every((request) => {
        const pathname = new URL(request.path, "http://localhost").pathname;
        return request.method === "GET" && ["/api/v1/me", `/api/v1/projects/${alternateProject.id}`, `/api/v1/projects/${alternateProject.id}/tasks`].includes(pathname);
      })).toBe(true);
      const sql = new Database(databaseFile, { readonly: true });
      try { expect(sql.prepare("SELECT project_id,repo_url,local_path FROM projects WHERE server_origin=?").all(originScopeWitness!.currentOrigin)).toEqual([{ project_id: alternateProject.id, repo_url: alternateProject.repoUrl, local_path: repositoryPaths[0] }]); }
      finally { sql.close(); }
      if (originShutdown) {
        const retained = row(tasks[1]!.id);
        expect(retained).toMatchObject({ status: "active", cleanup: null, resources: originScopeWitness!.originalResources, configuration: originScopeWitness!.originalConfiguration });
        const nativeProcessIds = JSON.parse(retained.native_execution).stopObservation.processIds as number[];
        expect(nativeProcessIds.length).toBeGreaterThan(0);
        for (const pid of nativeProcessIds) expect(() => process.kill(pid, 0)).not.toThrow();
        originScopeWitness!.preShutdownNativeProcessIds = nativeProcessIds;
        originScopeWitness!.preShutdownStatus = retained.status;
        originScopeWitness!.preShutdownCleanup = retained.cleanup;
        expect((await events()).some((event) => event.kind === "native-stop" && event.taskId === tasks[1]!.id)).toBe(false);
        expect(await readFile(sentinelFile, "utf8")).toContain("Uncommitted result belonging to authenticated user A.");
      }
    } else if (emptyRepositories) {
      await waitFor("existing-database worker held during initial Project selection", () => heldProjectInventories.length > 0);
      expect(guideWitness!.discoveryHeldAt).toBeGreaterThan(0);
      expect(heldProjectInventories).toHaveLength(1);
      expect(heldProjectInventories[0]!.writableEnded).toBe(false);
      expect(await readFile(path.join(home, ".daynight/config.yml"), "utf8")).toBe(guideWitness!.configuration);
    } else await waitFor("restarted worker held during project discovery", () => heldProjectReads > 0);
    if (committedDeadline) {
      const deadlineTask = parallelDeadlines ? first : tasks[1]!;
      if (parallelDeadlines) await waitFor("peer cleanup acknowledgement held", async () => (await events()).some((event) => event.kind === "cleanup-ack-held" && event.taskId === tasks[1]!.id));
      await waitFor("committed terminal cleanup despite blocked startup and one-hour polling", () => row(deadlineTask.id).status === "done", 8_000);
      cleanupCompletedAt = Date.now();
      expect(cleanupCompletedAt).toBeLessThanOrEqual(seededCleanup!.deadline + 5_000);
      const stop = (await events()).find((event) => event.kind === "native-stop" && event.taskId === deadlineTask.id)!;
      expect(stop.timestamp).toBeGreaterThanOrEqual(seededCleanup!.deadline);
      expect(stop.timestamp).toBeLessThanOrEqual(seededCleanup!.deadline + 5_000);
      expect(requests.slice(restartRequestOffset).some((request) => request.path.includes("workerId=") && (!originChanged || request.serverOrigin === sourceOrigin))).toBe(false);
      expect((await events()).filter((event) => event.kind === "prompt" && event.taskId === deadlineTask.id)).toHaveLength(1);
      expect((await events()).filter((event) => event.kind === "daemon-stop")).toHaveLength(0);
      if (emptyRepositories) {
        guideWitness!.cleanupCompletedWhileHeldAt = cleanupCompletedAt;
        expect(guideWitness!.discoveryHeldAt).toBeLessThanOrEqual(stop.timestamp);
        expect(heldProjectInventories).toHaveLength(1);
        expect(heldProjectInventories[0]!.writableEnded).toBe(false);
        expect(restartedWorker.child.exitCode).toBeNull();
        expect(JSON.parse(row(deadlineTask.id).cleanup)).toMatchObject({ ...seededCleanup, result: "timed-out", agentStopped: true, workspaceClosed: true, worktreeDeleted: true });
        expect(requests.slice(restartRequestOffset).every((request) => request.method === "GET")).toBe(true);
        expect((await events()).filter((event) => event.kind === "native-start")).toHaveLength(2);
      }
      if (parallelDeadlines) {
        const held = (await events()).find((event) => event.kind === "cleanup-ack-held" && event.taskId === tasks[1]!.id)!;
        expect(held.timestamp).toBeLessThan(stop.timestamp);
        const peer = row(tasks[1]!.id);
        const nativeProcessIds = JSON.parse(peer.native_execution).stopObservation.processIds as number[];
        peerPendingWitness = { timestamp: Date.now(), status: peer.status, input: JSON.parse(peer.cleanup).input as string, nativeProcessIds };
        expect(peerPendingWitness).toMatchObject({ status: "active", input: "unknown" });
        expect(nativeProcessIds.length).toBeGreaterThan(0);
        for (const pid of nativeProcessIds) expect(() => process.kill(pid, 0)).not.toThrow();
        expect((await events()).some((event) => event.taskId === tasks[1]!.id && (event.kind === "native-stop" || event.kind === "cleanup-ack-released"))).toBe(false);
        await writeFile(cleanupGateFile, "release original cleanup acknowledgement\n");
        await waitFor("peer cleanup after its original acknowledgement is released", () => row(tasks[1]!.id).status === "done", 8_000);
      }
    }
    if (emptyRepositories) {
      guideWitness!.discoveryFailedAt = Date.now();
      holdProjectInventory = false;
      for (const response of heldProjectInventories) send(response, { error: { code: "forbidden", message: "Fixture Project discovery refused after original cleanup.", requestId: "worker-guide-fixture" } }, 403);
      await expectExit(restartedWorker.closed, 1);
      expect(logs.slice(restartLogOffset).join("")).toContain("forbidden");
      expect(await readFile(path.join(home, ".daynight/config.yml"), "utf8")).toBe(guideWitness!.configuration);
    } else {
      expect(restartedWorker.child.kill("SIGINT")).toBe(true);
      await expectExit(restartedWorker.closed, 0);
    }
    const observed = await events();
    expect(observed.filter((event) => event.kind === "fixture-error")).toEqual([]);
    expect(observed.filter((event) => event.kind === "native-start").map((event) => event.taskId)).toEqual(tasks.map((task) => task.id));
    for (const event of observed.filter((item) => item.kind === "workspace" || item.kind === "native-start")) {
      expect(event.row?.status).toBe("active");
      expect(event.row?.userId).toBe(uuid(100));
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
      const unknownInput = committedDeadline && index === (parallelDeadlines ? 0 : 1);
      expect(observed.filter((event) => event.kind === "prompt" && event.taskId === task.id)).toHaveLength(unknownInput ? 1 : 2);
    }
    expect(observed.filter((event) => event.kind === "daemon-start")).toHaveLength(accountScope ? 2 : 1);
    expect(observed.filter((event) => event.kind === "daemon-stop")).toHaveLength(accountScope ? 2 : 1);
    if (accountScope) {
      const daemonStarts = observed.filter((event) => event.kind === "daemon-start");
      const firstStop = observed.find((event) => event.kind === "daemon-stop")!;
      expect(daemonStarts[1]!.timestamp).toBeGreaterThanOrEqual(firstStop.timestamp);
    }
    expect(observed.filter((event) => event.kind === "native-stop")).toHaveLength(2);
    expect(observed.filter((event) => event.kind === "workspace-close")).toHaveLength(2);
    if (!parallelDeadlines) expect(observed.findIndex((event) => event.kind === "native-start" && event.taskId === tasks[1]!.id)).toBeGreaterThan(observed.findIndex((event) => event.kind === "workspace-close" && event.taskId === first.id));
    expect(requests.filter((request) => request.method === "POST").map((request) => request.taskId)).toEqual(tasks.map((task) => task.id));
    expect(requests.some((request) => request.method === "GET" && /^\/api\/v1\/projects\/[^/]+\/tasks\/[^/?]+$/.test(request.path))).toBe(false);
    expect(row(first.id).status).toBe("done");
    await expect(readFile(path.join(repositoryPaths[0]!, ".worktrees/daynight", first.id, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const unfinished = row(tasks[1]!.id);
    if (committedDeadline) {
      expect(unfinished.status).toBe("done");
      const deadlineRow = parallelDeadlines ? row(first.id) : unfinished;
      expect(JSON.parse(deadlineRow.cleanup)).toMatchObject({ ...seededCleanup, result: "timed-out", agentStopped: true, workspaceClosed: true, worktreeDeleted: true, error: expect.any(String) });
      if (parallelDeadlines) expect(JSON.parse(unfinished.cleanup)).toMatchObject({ ...peerCleanup, input: "submitted", baseline: expect.any(Object), result: "completed", agentStopped: true, workspaceClosed: true, worktreeDeleted: true });
      await expect(readFile(path.join(repositoryPaths[1]!, ".worktrees/daynight", tasks[1]!.id, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(unfinished.status).toBe("active");
      expect(JSON.parse(unfinished.cleanup)).toMatchObject({ kind: "shutdown", agentStopped: true, workspaceClosed: true, worktreeDeleted: false });
      expect(await readFile(path.join(repositoryPaths[1]!, ".worktrees/daynight", tasks[1]!.id, "README.md"), "utf8")).toContain("Worker integration fixture");
      if (accountScope) {
        expect(unfinished).toMatchObject({ user_id: uuid(100), configuration: accountScopeWitness!.originalConfiguration, resources: accountScopeWitness!.originalResources });
        expect(await readFile(sentinelFile, "utf8")).toBe(accountScopeWitness!.sentinel);
      }
      if (originShutdown) {
        expect(unfinished).toMatchObject({ user_id: uuid(100), server_origin: sourceOrigin, configuration: originScopeWitness!.originalConfiguration, resources: originScopeWitness!.originalResources });
        expect(await readFile(sentinelFile, "utf8")).toContain("Uncommitted result belonging to authenticated user A.");
      }
    }
    const originalNativeId = JSON.parse(unfinished.resources).nativeSession.sessionId as string;
    expect(originalNativeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(path.join(codex, "sessions", `rollout-${originalNativeId}.jsonl`), "utf8")).toContain(path.join(repositoryPaths[1]!, ".worktrees/daynight", tasks[1]!.id));
    expect(tasks[1]!.properties.worker!.state).toBe(committedDeadline ? "completed" : "active");
    if (originChanged) {
      expect(unfinished.server_origin).toBe(sourceOrigin);
      expect(requests.filter((request) => request.serverOrigin === sourceOrigin)).toHaveLength(originScopeWitness!.sourceRequestsAtClosure);
    }
    const method = originChanged
      ? "Installed public launcher, real Git/SQLite/HTTP; origin A unavailable after worker crash, origin B supplies current identity and one configured inert Project with empty own-claim inventory"
      : emptyRepositories
        ? "Installed public launcher, real Git/SQLite/HTTP; existing database and empty repositories; original cleanup deadline advances while initial Project discovery is held, then discovery fails"
        : accountScope
          ? "Installed public launcher, real Git/SQLite/HTTP; normal user A shutdown then user B authentication with successful empty own inventory and scope pause"
          : "Installed public launcher, real Git/SQLite/HTTP; controlled Herdr and Codex metadata/native-process substitutes; SIGKILL then restart held in project GET";
    await writeFile(evidenceFile, JSON.stringify({
      outcome: "passed", scenario, method, nativeAgentExecution: false, receipt: installed.receipt,
      requests, inventoryResponses, events: observed, first: row(first.id), unfinished,
      ...(accountScopeWitness === null ? {} : { accountScopeWitness }),
      ...(originScopeWitness === null ? {} : { originScopeWitness: {
        ...originScopeWitness, sourceServerClosed, configuredRepositoryCount: 1,
        persistedCurrentOriginProjectCount: 1, freshCurrentOriginProjectId: alternateProject.id,
      } }),
      ...(guideWitness === null ? {} : { guideWitness }),
      ...(seededCleanup === null ? {} : { injection: {
        method: "Controlled SQL historical terminal-intent injection; this is not an observed prior remote-absence decision",
        cleanup: seededCleanup, pollIntervalMs: 3_600_000, projectReadHeld: holdProjectReads,
        projectInventoryHeldDuringCleanup: emptyRepositories, inventoryFaultEnabled: failInventoryReads,
        inventoryRequestsAfterRestart: requests.slice(restartRequestOffset).filter((request) => request.path.includes("workerId=")).length,
        cleanupCompletedAt, processingAllowanceMs: 5_000,
        ...(peerCleanup === null ? {} : { peerCleanup, peerPendingWitness }),
      } }),
      limitations: ["Linux controlled fixture only", "Does not establish model execution or native Herdr qualification", "Two-repository progression does not establish sustained-load fairness"],
    }, null, 2));
  } catch (error) {
    failure = error;
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, JSON.stringify({ outcome: "failed", scenario, method: "Installed worker controlled fixture", seededCleanup, error: error instanceof Error ? error.stack : String(error), requests, events: await events(), logs }, null, 2));
    throw error;
  }
  finally {
    const cleanupErrors: unknown[] = [];
    for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (error) { cleanupErrors.push(error); }
    const finalEvents = await events();
    for (const event of finalEvents) if (event.kind === "daemon-start" && event.pid !== undefined) {
      try {
        const processAbsent = (): boolean => {
          try { process.kill(event.pid!, 0); return false; }
          catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; }
        };
        if (finalEvents.some((item) => item.kind === "daemon-stop" && item.pid === event.pid)) {
          await waitFor("recorded fixture daemon process exit", processAbsent, 2_000);
          continue;
        }
        if (processAbsent()) continue;
        const environment = await readFile(`/proc/${event.pid}/environ`, "utf8");
        if (!environment.split("\0").includes(`FIXTURE_EVENTS=${eventsFile}`)) throw new Error("The fixture daemon PID was reused; its process group was retained.");
        process.kill(-event.pid, "SIGKILL");
        await waitFor("terminated fixture daemon process exit", processAbsent, 2_000);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "ENOENT"))) cleanupErrors.push(error);
      }
    }
    if (!sourceServerClosed) await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined || ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? resolve() : reject(error)); server.closeAllConnections(); }).catch((error: unknown) => { cleanupErrors.push(error); });
    if (alternateServer !== undefined) await new Promise<void>((resolve, reject) => { alternateServer!.close((error) => error === undefined ? resolve() : reject(error)); alternateServer!.closeAllConnections(); }).catch((error: unknown) => { cleanupErrors.push(error); });
    try { await installed?.cleanup(); } catch (error) { cleanupErrors.push(error); }
    try { await rm(home, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    await writeFile(cleanupEvidenceFile, JSON.stringify({ outcome: cleanupErrors.length === 0 ? "passed" : "failed", scenario, homeRemoved: !existsSync(home), installedArtifactRemoved: installed === undefined ? null : !existsSync(installed.receipt.root), errors: cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)) }, null, 2));
    if (cleanupErrors.length !== 0) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], "Installed worker fixture or cleanup failed.");
  }
});
