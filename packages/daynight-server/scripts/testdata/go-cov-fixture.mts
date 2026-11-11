import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const marker = 'panic: runner-capture-witness';
export const payload = Buffer.from([
  JSON.stringify({ Action: 'run', Package: 'example/pkg', Test: 'TestCrash' }),
  JSON.stringify({ Action: 'output', Package: 'example/pkg', Test: 'TestCrash', Output: marker + '\n' }),
  JSON.stringify({ Action: 'output', Package: 'example/pkg', Test: 'TestCrash', Output: '界'.repeat(30000) + '\n' }),
  JSON.stringify({ Action: 'fail', Package: 'example/pkg' }),
].join('\n'));
export const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
  const end = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < end, 'fixture did not reach its barrier');
    await delay(20);
  }
};
export const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);
export const stopped = (pid: number): boolean => {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
  assert.ifError(result.error);
  return result.status === 1 || result.stdout.trim().startsWith('Z');
};

export const fixture = async (t: TestContext, mode = 'normal', input = payload, fault?: string) => {
  const temporary = resolve(scripts, '../.tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'go-cov-test-'));
  const directory = join(root, 'scripts');
  await mkdir(directory);
  for (const name of ['command-timeout.mts', 'go-cov-capture.mts', 'go-test-output.mts']) {
    if (await exists(join(scripts, name))) await copyFile(join(scripts, name), join(directory, name));
  }
  await writeFile(join(root, 'input'), input);
  const fakeGo = [
    '#!' + process.execPath,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); const path=require("node:path");',
    'const root=process.env.FIXTURE_ROOT, mode=process.env.FIXTURE_MODE, args=process.argv.slice(2);',
    'fs.appendFileSync(path.join(root,"trace"),JSON.stringify({args,cwd:process.cwd(),flags:process.env.GOFLAGS,path:process.env.PATH})+"\\n");',
    'if(args[0]!=="test"){ process.stdout.write("example/pkg\\n"); process.exit(0); }',
    '(async()=>{',
    'const input=fs.readFileSync(path.join(root,"input"));',
    'if(["hang","early","kill-shim"].includes(mode)){',
    ' process.on("SIGTERM",()=>{});',
    ' const descendant=spawn(process.execPath,["-e",\'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.env.FIXTURE_ROOT+"/descendant-ready","");setInterval(()=>{},1000);\'],{stdio:"inherit"});',
    ' fs.writeFileSync(path.join(root,"pids"),JSON.stringify([process.pid,descendant.pid]));',
    ' while(!fs.existsSync(path.join(root,"descendant-ready"))) await new Promise(r=>setTimeout(r,10));',
    ' process.stdout.write(input.subarray(0,200)); fs.writeFileSync(path.join(root,"ready"),""); setInterval(()=>{},1000); return;',
    '}',
    'for(let i=0;i<input.length;i+=65536){ await new Promise((resolve,reject)=>process.stdout.write(input.subarray(i,i+65536),e=>e?reject(e):resolve())); fs.writeFileSync(path.join(root,"produced"),String(Math.min(i+65536,input.length))); }',
    'process.exitCode=Number(process.env.FIXTURE_GO_EXIT||0);',
    '})().catch(error=>{console.error(error);process.exit(1);});',
  ].join('\n');
  const fakeCov = [
    '#!' + process.execPath,
    'const fs=require("node:fs"); const {spawn,spawnSync}=require("node:child_process"); const path=require("node:path");',
    'const root=process.env.FIXTURE_ROOT,mode=process.env.FIXTURE_MODE;',
    'fs.writeFileSync(path.join(root,"cov-args"),JSON.stringify(process.argv.slice(2)));',
    'if(mode==="missing"){process.exit(0);}',
    'const list=spawnSync("go",["list","./..."],{encoding:"utf8"}); if(list.status!==0)process.exit(list.status||1);',
    'const child=spawn("go",["test","example/pkg","-json","-timeout=10m","argument with spaces"],{stdio:["ignore","pipe","inherit"]});',
    'let held=false; const received=fs.createWriteStream(path.join(root,"received"));',
    'child.stdout.on("data",chunk=>{',
    ' received.write(chunk);',
    ' if(mode==="hang")fs.writeFileSync(path.join(root,"capture-ready"),"");',
    ' if(mode==="early")process.exit(0);',
    ' if(mode==="kill-shim"){child.kill("SIGKILL");}',
    ' if(mode==="forward-failure"){child.stdout.destroy();}',
    ' if(mode==="slow"&&!held){held=true;child.stdout.pause();fs.writeFileSync(path.join(root,"held"),"");',
    '  const watcher=fs.watch(root,()=>{if(fs.existsSync(path.join(root,"release"))){watcher.close();child.stdout.resume();}});',
    ' }',
    '});',
    'child.on("close",(code,signal)=>{received.end(()=>{',
    ' if(["kill-shim","forward-failure","ignore-failure"].includes(mode))process.exit(0);',
    ' if(mode==="repeat"){spawnSync("go",["test","example/pkg","-json"],{stdio:"ignore"});process.exit(0);}',
    ' process.exit(code===null?128+require("node:os").constants.signals[signal]:code);',
    '});});',
  ].join('\n');
  await writeFile(join(root, 'go'), fakeGo, { mode: 0o755 });
  await writeFile(join(root, 'go-cov'), fakeCov, { mode: 0o755 });
  const preload = [
    'const fs=require("node:fs");',
    'if(process.argv[1]?.endsWith("command-timeout.mts")&&process.env.FIXTURE_DEADLINE_READY==="1"){',
    ' const schedule=global.setTimeout;',
    ' global.setTimeout=function(callback,milliseconds,...args){',
    '  if(milliseconds!==5000)return schedule(callback,milliseconds,...args);',
    '  const timer=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_ROOT+"/capture-ready")){clearInterval(timer);callback(...args);}},10);return timer;',
    ' };',
    '}',

    'if(process.argv[1]?.endsWith("go-test-output.mts")){',
    ' const open=fs.openSync,write=fs.writeSync,close=fs.closeSync;let target,seen=0;',
    ' fs.openSync=function(file,...args){if(String(file).endsWith("go-test.jsonl")){if(process.env.FIXTURE_FAULT==="open")throw Object.assign(new Error("capture open denied"),{code:"EACCES"});target=open.call(this,file,...args);return target;}return open.call(this,file,...args);};',
    ' fs.writeSync=function(fd,...args){if(fd===target&&process.env.FIXTURE_FAULT==="write"&&seen++>0)throw Object.assign(new Error("capture disk full"),{code:"ENOSPC"});return write.call(this,fd,...args);};',
    ' fs.closeSync=function(fd){const result=close.call(this,fd);if(fd===target&&process.env.FIXTURE_FAULT==="close")throw new Error("capture close failed");return result;};',
    '}',
  ].join('\n');
  await writeFile(join(root, 'fault.cjs'), preload);
  const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
    FIXTURE_ROOT: root, FIXTURE_MODE: mode, FIXTURE_FAULT: fault, FIXTURE_GO_EXIT: '0',
    GOFLAGS: '-race=true -coverpkg=example/pkg',
    NODE_OPTIONS: fault ? '--require=' + join(root, 'fault.cjs') : process.env.NODE_OPTIONS };
  let running: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  t.after(async () => {
    if (running?.exitCode === null && running?.signalCode === null) running.kill('SIGTERM');
    await closed;
    if (await exists(join(root, 'pids'))) {
      for (const pid of JSON.parse(await readFile(join(root, 'pids'), 'utf8')) as number[]) {
        if (!stopped(pid)) {
          try { process.kill(pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const args = (scope: string, duration: number) => [join(directory, 'command-timeout.mts'), String(duration), '100',
    process.execPath, join(directory, 'go-cov-capture.mts'), scope, join(root, 'go'), join(root, 'go-cov'),
    '--race=true', '--coverprofile=coverage.out'];
  return {
    root, env,
    run: (scope = 'module', duration = 5000) => {
      const result = spawnSync(process.execPath, args(scope, duration), { cwd: root, env, encoding: 'utf8', timeout: duration + 5000 });
      assert.ifError(result.error);
      return result;
    },
    start: (duration = 5000, deadlineAfterReady = false) => {
      const runEnv = deadlineAfterReady ? { ...env, FIXTURE_DEADLINE_READY: '1',
        NODE_OPTIONS: (env.NODE_OPTIONS ?? '') + ' --require=' + JSON.stringify(join(root, 'fault.cjs')) } : env;
      running = spawn(process.execPath, args('module', duration), { cwd: root, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      running.stdout!.on('data', chunk => { stdout += chunk; });
      running.stderr!.on('data', chunk => { stderr += chunk; });
      closed = once(running, 'close');
      return { child: running, closed, output: () => ({ stdout, stderr }),
        ready: (name: string) => waitFor(async () => {
          if (await exists(join(root, name))) return true;
          assert.equal(running!.exitCode, null, 'Fixture exited before ' + name + ': ' + stderr);
          assert.equal(running!.signalCode, null, 'Fixture was killed before ' + name + ': ' + stderr);
          return false;
        }) };

    },
    runs: async (scope = 'module') => {
      const base = join(root, '.tmp/go-test-evidence', scope);
      if (!await exists(base)) return [];
      return (await readdir(base)).sort().map(name => join(base, name));
    },
  };
};
