import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { assertCodexIntegrationHome, createHerdrEnvironment, createHerdrInstance, createHerdrNativeEnvironment, createHerdrVersionObserver, resolveHerdrInstancePaths } from "../../../src/commands/worker/herdr/instance.js";
import type { HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";
import { terminateOwnedHerdrProcess } from "../../../src/commands/worker/herdr/command.js";
import { herdrIpcAddress } from "../../../src/commands/worker/herdr/rpc.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { createToolLaunchMapping } from "../../../src/commands/worker/herdr/tool-launch.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const operations: Operation[] = [];
const operation = (totalMs = 5_000): Operation => { const op = createOperation({ limits: { totalMs, requestMs: totalMs } }); operations.push(op); return op; };
const waitUntil = async (condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!await condition()) { if (Date.now() >= deadline) throw new Error("The private Herdr fixture did not reach its checkpoint."); await new Promise<void>((resolve) => setTimeout(resolve, 10)); }
};
const present = async (file: string): Promise<boolean> => {
  try { await readFile(file); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
};

const daemonSource = `import { createServer } from 'node:net';
import { mkdir, appendFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write('herdr '+(process.env.FIXTURE_VERSION ?? '0.9.5')+'\\n'); process.exit(0); }
const root=process.env.XDG_CONFIG_HOME;
const directory=path.join(root,'herdr','sessions','w'); await mkdir(directory,{recursive:true});
const address=(name)=>process.platform==='win32'?'\\\\\\\\.\\\\pipe\\\\'+name:name;
const api=path.join(directory,'herdr.sock'),client=path.join(directory,'herdr-client.sock');
const events=process.env.FIXTURE_EVENTS;
await appendFile(events,JSON.stringify({kind:'start',pid:process.pid,env:{HERDR_CONFIG_PATH:process.env.HERDR_CONFIG_PATH,HISTFILE:process.env.HISTFILE,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,CODEX_THREAD_ID:process.env.CODEX_THREAD_ID}})+'\\n');
const sockets=new Set();
const waitFile=async(file)=>{if(!file)return;while(true){try{await access(file);return;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,10));}};
let stopped=false;
const apiServer=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let input='';socket.on('data',async chunk=>{input+=chunk;const end=input.indexOf('\\n');if(end<0)return;const request=JSON.parse(input.slice(0,end));input='';
let result;
if(request.method==='ping') result={type:'pong',version:process.env.FIXTURE_SERVER_VERSION??process.env.FIXTURE_VERSION??'0.9.5',protocol:22,capabilities:{detached_server_daemon:true}};
else if(request.method==='session.snapshot'){await appendFile(events,JSON.stringify({kind:'snapshot'})+'\\n');await waitFile(process.env.FIXTURE_SNAPSHOT_GATE);result={type:'session_snapshot',snapshot:{workspaces:[]}};}
else if(request.method==='server.stop'){result={type:'ok'};if(!stopped){stopped=true;setTimeout(async()=>{for(const item of sockets)item.destroy();apiServer.close();clientServer.close();await appendFile(events,JSON.stringify({kind:'endpoints-closed'})+'\\n');await waitFile(process.env.FIXTURE_EXIT_GATE);process.exit(0);},Number(process.env.FIXTURE_STOP_DELAY??'0'));}}
else throw new Error('Unexpected fixture request '+request.method);
if(!socket.destroyed)socket.end(JSON.stringify({id:request.id,result})+'\\n');});});
const clientServer=createServer(socket=>socket.end());
await new Promise(resolve=>apiServer.listen(address(api),resolve));
await appendFile(events,JSON.stringify({kind:'api-ready'})+'\\n');
await waitFile(process.env.FIXTURE_CLIENT_GATE);
await new Promise(resolve=>clientServer.listen(address(client),resolve));
process.stdout.write('private daemon started\\n');process.stderr.write('private daemon stderr\\n');
// Readers use file presence as the checkpoint, so publish only the complete PID.
const ready=process.env.FIXTURE_READY;
await writeFile(ready+'.next',String(process.pid));
await rename(ready+'.next',ready);
setInterval(()=>{},1000);
`;

const fixture = async (extra: NodeJS.ProcessEnv = {}) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(scratch, { recursive: true });
  const physicalRoot = await mkdtemp(`${scratch}${path.sep}`); roots.push(physicalRoot);
  // AF_UNIX endpoints keep their real protocol length limit inside long worktrees.
  let root = physicalRoot;
  if (process.platform !== "win32") { const alias = path.join("/tmp", `dn-a0bc-${randomUUID().slice(0, 8)}`); await symlink(scratch, alias); roots.push(alias); root = path.join(alias, path.basename(physicalRoot)); }
  const script = path.join(root, "daemon.mjs"); await writeFile(script, daemonSource);
  const events = path.join(root, "events.jsonl"); const ready = path.join(root, "ready");
  const worker = { herdrDirectory: root, logsDirectory: path.join(root, "l") };
  const environment: NodeJS.ProcessEnv = { ...process.env, FIXTURE_EVENTS: events, FIXTURE_READY: ready, ...extra };
  const start: HerdrSpawn = (_file, args, options) => { const child = spawn(process.execPath, [script, ...args], options); children.push(child); return child; };
  const instance = createHerdrInstance({ paths: worker, environment, spawnProcess: start });
  return { root, worker, environment, script, events, ready, start, instance };
};

afterEach(async () => {
  operations.splice(0).forEach((op) => op.dispose());
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
    terminateOwnedHerdrProcess(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("A private Herdr fixture process remained alive.")), 3_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private Herdr instance", () => {
  it.skipIf(process.platform === "win32")("registers the final mapped Bash process only after its explicit startup nonce is ready", async () => {
    const f = await fixture();
    const herdrLaunch = await resolveToolLaunch({ tool: "herdr", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: f.environment, cwd: f.root }, operation());
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, toolLaunch: herdrLaunch, spawnProcess: f.start });
    await instance.ensure(operation());
    const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: f.environment, cwd: f.root }, operation());
    const mapping = (await createToolLaunchMapping({ directory: f.root, owner: { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() }, launch, nativeEnvironment: f.environment }, operation()))!;
    const startup = instance.createShellStartup()!, terminal = parseToml(await readFile(instance.paths.configurationFile, "utf8")).terminal as { default_shell: string };
    expect(startup.nonce).not.toBe(mapping.nonce);
    const shell = spawn(terminal.default_shell, ["-i", "-c", "read -r release"], { env: { ...f.environment, ...mapping.environment, DAYNIGHT_HERDR_SHELL_NONCE: startup.nonce }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    children.push(shell);
    const closed = once(shell, "close"), timer = setTimeout(() => shell.kill("SIGKILL"), 4_000);
    try {
      await mapping.verifyReady(shell.pid!, operation(), startup.nonce);
      expect(await startup.isReady(shell.pid!)).toBe(true);
      await mapping.captureProcesses([shell.pid!], operation());
      await mapping.verifyProcesses({ shellPid: shell.pid! }, operation());
    } finally { shell.stdin!.end("release\n"); await closed; clearTimeout(timer); await instance.stop(operation()); }
  });

  it("uses the frozen Herdr command for both version and daemon spawn and its attachment", async () => {
    const f = await fixture(), calls: { file: string; args: readonly string[] }[] = [];
    const toolLaunch = await resolveToolLaunch({ tool: "herdr", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: f.environment, cwd: f.root }, operation());
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, toolLaunch, spawnProcess: (file, args, options) => { calls.push({ file, args }); return f.start(file, args, options); } });
    expect(await instance.ensure(operation())).toMatchObject({ version: "0.9.5", protocol: 22 });
    expect(calls).toEqual([{ file: toolLaunch.command.file, args: ["--version"] }, { file: toolLaunch.command.file, args: ["--session", "w", "server"] }]);
    expect(instance.attachment).toMatchObject({ executable: toolLaunch.command.file, arguments: ["--session", "w"] });
    await instance.stop(operation());
  });
  it.skipIf(process.platform === "win32")("reconnects the original controlled shell using its recorded helper runtime after an installation moves", async () => {
    const f = await fixture();
    const toolLaunch = await resolveToolLaunch({ tool: "herdr", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: f.environment, cwd: f.root }, operation());
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, toolLaunch, spawnProcess: f.start });
    await instance.ensure(operation());
    const original = instance.toolMappingRuntime(), moved = { nodeExecutable: path.join(f.root, "removed-node"), childEntry: path.join(f.root, "removed-helper.js") };
    await writeFile(path.join(f.root, "shell-tool-runtime.json"), JSON.stringify(moved), { mode: 0o600 });
    const rcFile = path.join(f.root, "shell.rc"), rc = (await readFile(rcFile, "utf8")).replaceAll(original.nodeExecutable, moved.nodeExecutable).replaceAll(original.childEntry, moved.childEntry);
    await writeFile(rcFile, rc);
    const reconnected = createHerdrInstance({ paths: f.worker, environment: f.environment, toolLaunch, spawnProcess: () => { throw new Error("An existing endpoint must not spawn another helper or daemon."); } });
    expect(await reconnected.connect(operation())).toMatchObject({ reconnected: true });
    expect(reconnected.toolMappingRuntime()).toEqual(moved);
    expect(await readFile(rcFile, "utf8")).toBe(rc);
    await instance.stop(operation());
  });
  it.skipIf(process.platform !== "darwin")("runs new isolated panes without user shell startup files while retaining PATH and native homes", async () => {
    const f = await fixture();
    const home = path.join(f.root, "native-home"); await mkdir(home);
    const marker = path.join(home, "startup-ran");
    await writeFile(path.join(home, ".bashrc"), `printf changed > '${marker}'\nexport PATH=/unrelated\n`);
    const instance = createHerdrInstance({ paths: f.worker, environment: { ...f.environment, HOME: home }, spawnProcess: f.start, isolatedRun: true });
    await instance.ensure(operation());
    const startup = instance.createShellStartup()!;
    expect(startup.executable).toBe("/bin/bash");
    expect(await startup.isReady(process.pid)).toBe(false);
    const config = parseToml(await readFile(instance.paths.configurationFile, "utf8"));
    expect(config.terminal).toMatchObject({ shell_mode: "non_login", default_shell: expect.any(String) });
    const terminal = config.terminal as { default_shell: string };
    const launched = spawnSync(terminal.default_shell, ["-i"], { input: 'printf "%s\\n%s\\nnonce:%s\\n" "$PATH" "$CODEX_HOME" "${DAYNIGHT_HERDR_SHELL_NONCE-unset}"; exit\n', env: { ...process.env, HOME: home, PATH: "/checked/native/bin:/usr/bin:/bin", CODEX_HOME: "/retained/native/home", DAYNIGHT_HERDR_SHELL_NONCE: startup.nonce, PROMPT_COMMAND: "exec /usr/bin/false", PS1: '$(printf INHERITED_PROMPT)', PS2: '$(printf INHERITED_PROMPT)' }, encoding: "utf8", timeout: 10_000 });
    expect({ status: launched.status, signal: launched.signal, error: launched.error?.message, stdout: launched.stdout, stderr: launched.stderr }).toMatchObject({ status: 0 });
    expect(launched.stdout).toBe("/checked/native/bin:/usr/bin:/bin\n/retained/native/home\nnonce:unset\n");
    expect(launched.stderr).not.toContain("INHERITED_PROMPT");
    expect(existsSync(marker)).toBe(false);
    expect(await startup.isReady(launched.pid)).toBe(true);
    expect((await stat(path.join(f.root, "shell-ready", `${startup.nonce}.${launched.pid}`))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(f.root, "shell-ready"))).mode & 0o777).toBe(0o700);
    expect(await startup.isReady(launched.pid + 1)).toBe(false);
    expect(await instance.createShellStartup()!.isReady(launched.pid)).toBe(false);
    const bin = path.join(home, "bin"); await mkdir(bin);
    await writeFile(path.join(bin, "native-provider"), '#!/bin/sh\nprintf checked-executable\n', { mode: 0o700 });
    const inheritedFunction = spawnSync(terminal.default_shell, ["-i", "-c", "native-provider"], {
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, "BASH_FUNC_native-provider%%": "() { printf unchecked-function; }" }, encoding: "utf8", timeout: 10_000,
    });
    expect(inheritedFunction.status).toBe(0);
    expect(inheritedFunction.stdout).toBe("checked-executable");
    expect(await readdir(path.join(f.root, "shell-ready"))).toEqual([`${startup.nonce}.${launched.pid}`]);
    await instance.stop(operation());
  });

  it.skipIf(process.platform !== "darwin")("rejects stale or redirected managed shell readiness files", async () => {
    const f = await fixture();
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: f.start, isolatedRun: true });
    await instance.ensure(operation());
    const startup = instance.createShellStartup()!, pid = 1234;
    const file = path.join(f.root, "shell-ready", `${startup.nonce}.${pid}`);
    await writeFile(file, `00000000-0000-4000-8000-000000000000\n${pid}\n`, { mode: 0o600 });
    expect(await startup.isReady(pid)).toBe(false);
    await writeFile(file, `${startup.nonce}\n${pid + 1}\n`);
    expect(await startup.isReady(pid)).toBe(false);
    await rm(file); const target = path.join(f.root, "redirected-ready"); await writeFile(target, `${startup.nonce}\n${pid}\n`); await symlink(target, file);
    await expect(startup.isReady(pid)).rejects.toThrow();
    await instance.stop(operation());
  });

  it.skipIf(process.platform !== "darwin")("reconnects a legacy isolated daemon without replacing its shell configuration and refuses to restart its directory", async () => {
    const f = await fixture(); await f.instance.ensure(operation());
    const legacy = "onboarding = false\n\n[session]\nresume_agents_on_restore = false\n\n[update]\nversion_check = false\nmanifest_check = false\n";
    await writeFile(f.instance.paths.configurationFile, legacy);
    const other = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: () => { throw new Error("Must not restart the old daemon"); }, isolatedRun: true });
    expect(await other.ensure(operation())).toMatchObject({ reconnected: true });
    expect(await other.connect(operation())).toMatchObject({ reconnected: true });
    expect(other.createShellStartup()).toBeUndefined();
    expect(await readFile(f.instance.paths.configurationFile, "utf8")).toBe(legacy);
    expect(existsSync(path.join(f.root, "shell"))).toBe(false);
    await f.instance.stop(operation());
    await expect(other.ensure(operation())).rejects.toThrow("differs from the managed");
    expect(await readFile(f.instance.paths.configurationFile, "utf8")).toBe(legacy);
  });
  it("waits for durable daemon registration before observing readiness", async () => {
    const setup = await fixture();
    let captured = 0;
    const instance = createHerdrInstance({ paths: setup.worker, environment: setup.environment, spawnProcess: setup.start,
      onDaemonSpawn: async pid => { captured = pid; throw new Error("journal refused"); }, retainOnStartupFailure: true });
    await expect(instance.ensure(operation())).rejects.toThrow("journal refused");
    expect(captured).toBeGreaterThan(0);
    expect(children.at(-1)!.signalCode).toBeNull();
  });
  it.skipIf(!existsSync(new URL("../../../dist/commands/worker/herdr/instance.js", import.meta.url)))
  .each(["registration", "readiness"] as const)("lets the parent exit naturally while retaining its daemon after %s failure", async (failure) => {
    const f = await fixture(failure === "readiness" ? { FIXTURE_SERVER_VERSION: "0.8.2" } : {});
    const resultFile = path.join(f.root, "startup-result.json");
    const instanceUrl = new URL("../../../dist/commands/worker/herdr/instance.js", import.meta.url).href;
    const operationUrl = new URL("../../../dist/api/operation.js", import.meta.url).href;
    const source = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';import {createHerdrInstance} from ${JSON.stringify(instanceUrl)};import {createOperation} from ${JSON.stringify(operationUrl)};
const config=JSON.parse(process.argv[1]);let daemonPid;const instance=createHerdrInstance({paths:config.worker,retainOnStartupFailure:true,spawnProcess:(_file,args,options)=>spawn(process.execPath,[config.script,...args],options),onDaemonSpawn:async pid=>{daemonPid=pid;if(config.failure==='registration')throw new Error('journal refused');}});
const operation=createOperation({limits:{totalMs:5000,requestMs:5000}});try{await instance.ensure(operation);writeFileSync(config.resultFile,JSON.stringify({daemonPid,unexpectedSuccess:true}));}catch(error){writeFileSync(config.resultFile,JSON.stringify({daemonPid,error:error.message}));}finally{operation.dispose();}`;
    const parent = spawn(process.execPath, ["--input-type=module", "--eval", source, JSON.stringify({ worker: f.worker, script: f.script, resultFile, failure })],
      { env: f.environment, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    children.push(parent);
    let stderr = ""; parent.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => parent.once("close", (code, signal) => resolve({ code, signal })));
    const retained = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: () => { throw new Error("The retained daemon must not be replaced"); } });
    try {
      let result: { daemonPid: number; error?: string } | undefined;
      await waitUntil(async () => {
        if (!await present(resultFile) || !await present(f.ready)) return false;
        try { result = JSON.parse(await readFile(resultFile, "utf8")) as typeof result; return true; }
        catch (error) { if (error instanceof SyntaxError) return false; throw error; }
      });
      expect(result!.error).toMatch(failure === "registration" ? /journal refused/ : /protocol 22/);
      expect(Number(await readFile(f.ready, "utf8"))).toBe(result!.daemonPid);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([closed, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000); })]);
        expect(outcome, stderr || "Retained daemon handle prevented the parent from exiting naturally").toEqual({ code: 0, signal: null });
      } finally { if (timer !== undefined) clearTimeout(timer); }
      expect(await createHerdrVersionObserver(f.worker).observe(operation())).toBe(failure === "readiness" ? "0.8.2" : "0.9.5");
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) { parent.kill("SIGKILL"); await closed; }
      await retained.stop(operation(2_000));
    }
  }, 15_000);

  it("observes absence without creating private paths or starting a daemon", async () => {
    const setup = await fixture();
    const absent = { herdrDirectory: path.join(setup.root, "a"), logsDirectory: setup.worker.logsDirectory };
    expect(await createHerdrVersionObserver(absent).observe(operation())).toBeNull();
    expect(existsSync(absent.herdrDirectory)).toBe(false); expect(children).toHaveLength(0);
  });

  it("reads the actual private daemon version without a session snapshot or configuration mutation", async () => {
    const setup = await fixture(); await setup.instance.ensure(operation());
    const before = await readFile(setup.events, "utf8"); const config = await readFile(setup.instance.paths.configurationFile, "utf8");
    expect(await createHerdrVersionObserver(setup.worker).observe(operation())).toBe("0.9.5");
    expect(await readFile(setup.events, "utf8")).toBe(before);
    expect(await readFile(setup.instance.paths.configurationFile, "utf8")).toBe(config);
    expect(children).toHaveLength(2);
  });

  it("shares the native agent environment while restoring inherited XDG roots", () => {
    const inherited = { PATH: "/bin", XDG_CONFIG_HOME: "/native/config", HERDR_SESSION: "outer", CODEX_THREAD_ID: "private", CODEX_HOME: "/native/codex" };
    const environment = createHerdrNativeEnvironment({ herdrDirectory: path.resolve("private-herdr") }, inherited);
    expect(environment).toMatchObject({ PATH: "/bin", XDG_CONFIG_HOME: "/native/config", CODEX_HOME: "/native/codex" });
    expect(environment.XDG_STATE_HOME).toBeUndefined(); expect(environment.HERDR_SESSION).toBeUndefined(); expect(environment.CODEX_THREAD_ID).toBeUndefined();
    expect(inherited.HERDR_SESSION).toBe("outer");
  });
  it.each([
    [{ HOME: "/native" }, "/native/.codex", "linux"],
    [{ HOME: "/wrong", CODEX_HOME: "/explicit" }, "/explicit", "linux"],
    [{ HOME: "C:\\native", USERPROFILE: "C:\\other" }, "C:\\native\\.codex", "win32"],
    [{ HOME: "", USERPROFILE: "C:\\profile" }, "C:\\profile\\.codex", "win32"],
    [{ HOMEDRIVE: "C:", HOMEPATH: "\\profile" }, "C:\\profile\\.codex", "win32"],
    [{ HOME: "C:\\wrong", CODEX_HOME: "C:\\explicit" }, "C:\\explicit", "win32"],
    [{ home: "C:\\wrong", codex_home: "C:\\explicit" }, "C:\\explicit", "win32"],
  ] as const)("binds the installer root to daemon environment %j", (environment, root, platform) => {
    expect(() => assertCodexIntegrationHome(environment, root, platform)).not.toThrow();
  });

  it.each([
    [{}, "/os-home/.codex", "linux"],
    [{ HOME: "relative" }, "/os-home/.codex", "linux"],
    [{ CODEX_HOME: "relative", HOME: "/native" }, "/native/.codex", "linux"],
    [{ HOME: "C:\\native", USERPROFILE: "C:\\profile" }, "C:\\profile\\.codex", "win32"],
    [{ USERPROFILE: "/native" }, "/native/.codex", "linux"],
    [{ CODEX_HOME: "/a/symlink/../native" }, "/a/native", "linux"],
    [{ HOME: "/a/symlink/../native" }, "/a/native/.codex", "linux"],
    [{ codex_home: "C:\\other", HOME: "C:\\native" }, "C:\\native\\.codex", "win32"],
    [{ USERPROFILE: "C:\\a\\symlink\\..\\native" }, "C:\\a\\native\\.codex", "win32"],
    [{ HOMEDRIVE: "C:", HOMEPATH: "\\a\\symlink\\..\\native" }, "C:\\a\\native\\.codex", "win32"],
    [{ CODEX_HOME: undefined, codex_home: "C:\\a\\.codex", HOME: "C:\\b", USERPROFILE: "C:\\a" }, "C:\\a\\.codex", "win32"],
  ] as const)("refuses an unproven native home %j", (environment, root, platform) => {
    expect(() => assertCodexIntegrationHome(environment, root, platform)).toThrow("does not match the inspected directory");
  });

  it("allows integration repair only for its own live daemon and captured native home", async () => {
    const root = path.resolve("native-config");
    const f = await fixture({ CODEX_HOME: root });
    expect(() => f.instance.assertIntegrationEnvironment(root)).toThrow("not a live process");
    await f.instance.ensure(operation());
    expect(() => f.instance.assertIntegrationEnvironment(root)).not.toThrow();
    f.instance.environment.CODEX_HOME = path.resolve("different-config");
    expect(() => f.instance.assertIntegrationEnvironment(root)).not.toThrow();
    expect(() => f.instance.assertIntegrationEnvironment(f.instance.environment.CODEX_HOME!)).toThrow("does not match");
    const other = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: f.start });
    await other.ensure(operation());
    expect(() => other.assertIntegrationEnvironment(root)).toThrow("not a live process");
    await f.instance.stop(operation());
    expect(() => f.instance.assertIntegrationEnvironment(root)).toThrow("not a live process");
  });

  it("derives fixed private paths and rejects both socket and pipe limits without a fallback", () => {
    const linux = resolveHerdrInstancePaths({ herdrDirectory: "/home/a/.daynight/worker/h", logsDirectory: "/home/a/.daynight/worker/logs" }, "linux");
    expect(linux.apiEndpoint).toBe("/home/a/.daynight/worker/h/c/herdr/sessions/w/herdr.sock");
    expect(linux.clientEndpoint).toContain("herdr-client.sock");
    expect(Buffer.byteLength(resolveHerdrInstancePaths({ herdrDirectory: `/${"a".repeat(65)}`, logsDirectory: "/logs" }, "darwin").clientEndpoint)).toBe(103);
    expect(() => resolveHerdrInstancePaths({ herdrDirectory: `/${"a".repeat(66)}`, logsDirectory: "/logs" }, "darwin")).toThrow("103 UTF-8 bytes");
    expect(() => resolveHerdrInstancePaths({ herdrDirectory: `/${"中".repeat(30)}`, logsDirectory: "/logs" }, "linux")).toThrow("107 UTF-8 bytes");
    expect(() => resolveHerdrInstancePaths({ herdrDirectory: `C:\\${"a".repeat(220)}`, logsDirectory: "C:\\logs" }, "win32")).toThrow("256 characters");
    expect(() => resolveHerdrInstancePaths({ herdrDirectory: "relative", logsDirectory: "/logs" }, "linux")).toThrow("absolute");
  });

  it("isolates Herdr routing while preserving native homes and clearing caller session identities", () => {
    const paths = resolveHerdrInstancePaths({ herdrDirectory: "/private/h", logsDirectory: "/private/l" }, "linux");
    const original = { HOME: "/user", USERPROFILE: "C:\\user", CODEX_HOME: "/codex", COPILOT_HOME: "/copilot", CODEX_SQLITE_HOME: "/sqlite", HISTFILE: "/user/.bash_history",
      HERDR_SOCKET_PATH: "/human", HERDR_CLIENT_SOCKET_PATH: "/human-client", HERDR_SESSION: "human", HERDR_ACTIVE_PANE_ID: "old", CODEX_THREAD_ID: "old", CODEX_SESSION_ID: "old", CODEX_TOOL_CALL_ID: "old", AUTH_SETTING: "preserved" };
    const env = createHerdrEnvironment(paths, original);
    expect(env).toMatchObject({ HOME: "/user", USERPROFILE: "C:\\user", CODEX_HOME: "/codex", COPILOT_HOME: "/copilot", CODEX_SQLITE_HOME: "/sqlite", AUTH_SETTING: "preserved", XDG_CONFIG_HOME: "/private/h/c", XDG_STATE_HOME: "/private/h/s", HERDR_CONFIG_PATH: "/private/h/config.toml", HISTFILE: "/private/h/shell.history" });
    for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION", "HERDR_ACTIVE_PANE_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID"]) expect(env).not.toHaveProperty(key);
    expect(original.CODEX_THREAD_ID).toBe("old"); expect(original.HISTFILE).toBe("/user/.bash_history");
  });

  it("creates false-restore configuration, uses detached direct log descriptors and reconnects without spawning", async () => {
    const f = await fixture({ CODEX_THREAD_ID: "parent", CODEX_HOME: "/preserved-native-home" });
    const first = await f.instance.ensure(operation()); expect(first).toMatchObject({ reconnected: false, version: "0.9.5", protocol: 22 });
    expect(await readFile(f.instance.paths.configurationFile, "utf8")).toBe("onboarding = false\n\n[session]\nresume_agents_on_restore = false\n");
    expect(await readFile(f.instance.paths.stdoutLogFile, "utf8")).toContain("private daemon started");
    expect(await readFile(f.instance.paths.stderrLogFile, "utf8")).toContain("private daemon stderr");
    const other = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: () => { throw new Error("Must reconnect without spawning"); } });
    expect(await other.ensure(operation())).toMatchObject({ reconnected: true });
    const event = JSON.parse((await readFile(f.events, "utf8")).split("\n")[0]!);
    expect(event.env).toMatchObject({ CODEX_HOME: "/preserved-native-home", HERDR_CONFIG_PATH: f.instance.paths.configurationFile, HISTFILE: f.instance.paths.shellHistoryFile }); expect(event.env).not.toHaveProperty("CODEX_THREAD_ID");
    expect(other.attachment).toMatchObject({ arguments: ["--session", "w"], environment: { HERDR_CONFIG_PATH: f.instance.paths.configurationFile, HISTFILE: f.instance.paths.shellHistoryFile } });
    expect(Object.keys(other.attachment.environment).every((key) => ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME", "COPILOT_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_CONFIG_PATH", "HISTFILE"].includes(key))).toBe(true);
    expect(await other.stop(operation())).toEqual({ apiClosed: true, clientClosed: true, ownedChildClosed: null });
    expect(await f.instance.stop(operation())).toEqual({ apiClosed: true, clientClosed: true, ownedChildClosed: true });
  });

  it("inspects an existing managed daemon without configuration writes or starting another process", async () => {
    const f = await fixture(); await f.instance.ensure(operation());
    const original = await readFile(f.instance.paths.configurationFile, "utf8");
    const other = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: () => { throw new Error("Read-only attachment must not start a daemon"); } });
    expect(await other.connect(operation())).toMatchObject({ reconnected: true, version: "0.9.5", protocol: 22 });
    expect(await readFile(f.instance.paths.configurationFile, "utf8")).toBe(original);
    await f.instance.stop(operation());
  });

  it("refuses attachment when no managed daemon exists without creating configuration or logs", async () => {
    const f = await fixture();
    await expect(f.instance.connect(operation())).rejects.toThrow("daynight worker run");
    expect(await present(f.instance.paths.configurationFile)).toBe(false);
    expect(await present(f.instance.paths.stdoutLogFile)).toBe(false);
    expect(await present(f.events)).toBe(false);
  });

  it("refuses a modified managed configuration without rewriting it for attachment", async () => {
    const f = await fixture();
    await writeFile(f.instance.paths.configurationFile, "[session]\nresume_agents_on_restore=true\n");
    await expect(f.instance.connect(operation())).rejects.toThrow("differs from the managed");
    expect(await readFile(f.instance.paths.configurationFile, "utf8")).toContain("true");
    expect(await present(f.events)).toBe(false);
  });

  it("does not attach a completed startup operation to the persistent daemon lifetime", async () => {
    const f = await fixture(); const startup = operation(); await f.instance.ensure(startup); startup.dispose();
    expect(await f.instance.ensure(operation())).toMatchObject({ reconnected: true });
    expect(await f.instance.stop(operation())).toEqual({ apiClosed: true, clientClosed: true, ownedChildClosed: true });
  });

  it("waits for restored snapshot and both endpoint listeners instead of an early ping", async () => {
    const f = await fixture(); const gate = path.join(f.root, "allow-snapshot"); f.environment.FIXTURE_SNAPSHOT_GATE = gate;
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: f.start }); let completed = false;
    const pending = instance.ensure(operation()).then((result) => { completed = true; return result; });
    await waitUntil(async () => await present(f.events) && (await readFile(f.events, "utf8")).includes('"snapshot"'));
    expect(completed).toBe(false); await writeFile(gate, "ready"); await pending;
    expect(await instance.stop(operation())).toMatchObject({ ownedChildClosed: true });
  });

  it("keeps a follower cancellation separate from the shared startup owner", async () => {
    const f = await fixture(); const gate = path.join(f.root, "allow-snapshot"); f.environment.FIXTURE_SNAPSHOT_GATE = gate;
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: f.start });
    const first = instance.ensure(operation()); await waitUntil(async () => await present(f.events) && (await readFile(f.events, "utf8")).includes('"snapshot"'));
    const follower = operation(); const second = instance.ensure(follower); follower.dispose(); await expect(second).rejects.toThrow("disposed");
    await writeFile(gate, "ready"); expect(await first).toMatchObject({ reconnected: false }); await instance.stop(operation());
  });

  it("requires actual owned child closure after stop acknowledgement and endpoint closure", async () => {
    const f = await fixture(); const gate = path.join(f.root, "allow-exit"); f.environment.FIXTURE_EXIT_GATE = gate;
    const instance = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: f.start }); await instance.ensure(operation());
    let completed = false; const stopping = instance.stop(operation()).then((result) => { completed = true; return result; });
    await waitUntil(async () => (await readFile(f.events, "utf8")).includes('"endpoints-closed"'));
    expect(completed).toBe(false); await writeFile(gate, "exit"); expect(await stopping).toEqual({ apiClosed: true, clientClosed: true, ownedChildClosed: true });
  });

  it("refuses modified private configuration and incompatible executable versions before daemon startup", async () => {
    const f = await fixture({ FIXTURE_VERSION: "0.8.2" }); await expect(f.instance.ensure(operation())).rejects.toThrow("0.9.5 or newer"); expect(await present(f.events)).toBe(false);
    await writeFile(f.instance.paths.configurationFile, "[session]\nresume_agents_on_restore=true\n");
    const current = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: f.start }); await expect(current.ensure(operation())).rejects.toThrow("differs from the managed");
    expect(await readFile(f.instance.paths.configurationFile, "utf8")).toContain("true");
  });

  it("does not treat a partial existing endpoint set as an absent instance", async () => {
    const f = await fixture(); await mkdir(f.instance.paths.sessionDirectory, { recursive: true });
    const server = createServer((socket) => socket.end()); await new Promise<void>((resolve) => server.listen(herdrIpcAddress(f.instance.paths.apiEndpoint), resolve));
    try { await expect(f.instance.ensure(operation())).rejects.toThrow("only one reachable endpoint"); expect(await present(f.events)).toBe(false); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
  });

  it("retains an existing incompatible private server instead of spawning or stopping it", async () => {
    const f = await fixture(); await mkdir(f.instance.paths.sessionDirectory, { recursive: true });
    const api = createServer((socket) => socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString()); socket.end(JSON.stringify({ id: request.id, result: { type: "pong", version: "0.8.2", protocol: 21, capabilities: {} } }) + "\n");
    }));
    const client = createServer((socket) => socket.end());
    await Promise.all([new Promise<void>((resolve) => api.listen(herdrIpcAddress(f.instance.paths.apiEndpoint), resolve)), new Promise<void>((resolve) => client.listen(herdrIpcAddress(f.instance.paths.clientEndpoint), resolve))]);
    try {
      await expect(f.instance.ensure(operation())).rejects.toThrow("protocol 22"); expect(api.listening).toBe(true); expect(client.listening).toBe(true); expect(await present(f.events)).toBe(false);
    } finally {
      await Promise.all([new Promise<void>((resolve, reject) => api.close((error) => error === undefined ? resolve() : reject(error))), new Promise<void>((resolve, reject) => client.close((error) => error === undefined ? resolve() : reject(error)))]);
    }
  });

  it("terminates only the newly owned daemon when its ready API is incompatible", async () => {
    const f = await fixture({ FIXTURE_SERVER_VERSION: "0.8.2" });
    await expect(f.instance.ensure(operation())).rejects.toThrow("protocol 22");
    expect(await present(f.events)).toBe(true); const daemon = children.at(-1)!; expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true);
  });

  it.skipIf(!existsSync(new URL("../../../dist/commands/worker/herdr/instance.js", import.meta.url)))
  ("survives a real parent crash with file-backed logs and reconnects to the original daemon", async () => {
    const f = await fixture();
    const instanceUrl = new URL("../../../dist/commands/worker/herdr/instance.js", import.meta.url).href;
    const operationUrl = new URL("../../../dist/api/operation.js", import.meta.url).href;
    const source = `import {spawn} from 'node:child_process';import {createHerdrInstance} from ${JSON.stringify(instanceUrl)};import {createOperation} from ${JSON.stringify(operationUrl)};
const config=JSON.parse(process.argv[1]);const instance=createHerdrInstance({paths:config.worker,environment:config.environment,spawnProcess:(_file,args,options)=>spawn(process.execPath,[config.script,...args],options)});const operation=createOperation({limits:{totalMs:5000,requestMs:5000}});await instance.ensure(operation);operation.dispose();process.send('ready');setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["--input-type=module", "--eval", source, JSON.stringify({ worker: f.worker, environment: f.environment, script: f.script })], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(parent);
    let stderr = ""; parent.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    const ready = new Promise<void>((resolve, reject) => { parent.once("message", () => resolve()); parent.once("exit", () => reject(new Error(stderr || "Fixture parent exited before readiness"))); parent.once("error", reject); });
    const reconnected = createHerdrInstance({ paths: f.worker, environment: f.environment, spawnProcess: () => { throw new Error("Must retain the orphaned private daemon"); } });
    try {
      await ready; parent.kill("SIGKILL"); await new Promise<void>((resolve) => parent.once("close", () => resolve()));
      expect(await reconnected.ensure(operation())).toMatchObject({ reconnected: true });
      expect(await readFile(reconnected.paths.stdoutLogFile, "utf8")).toContain("private daemon started");
      expect(await reconnected.stop(operation())).toEqual({ apiClosed: true, clientClosed: true, ownedChildClosed: null });
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) { parent.kill("SIGKILL"); await new Promise<void>((resolve) => parent.once("close", () => resolve())); }
      await reconnected.stop(operation(2_000));
    }
  });
});
