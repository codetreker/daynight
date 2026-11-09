import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWindowsJobKernel } from "../../../src/platform/windows-job.js";
import { createWindowsReviewJobScope } from "../../../src/commands/review/windows-job-scope.js";
import { spawnWindowsReviewPhase } from "../../../src/commands/review/windows-phase.js";

let directory: string;
beforeAll(async () => { const root = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, "native-review-job-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const until = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = performance.now() + 10_000;
  while (!await check()) { if (performance.now() >= deadline) throw new Error("Native Job fixture barrier did not complete."); await new Promise(resolve => setTimeout(resolve, 10)); }
};
// libuv adds non-detached children to the parent's kill-on-close Job. Detach
// only the leaf so it survives middle exit while inheriting the held review Job;
// detached spawn omits CREATE_BREAKAWAY_FROM_JOB. Membership is checked below.
// https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1052-L1087
const fixtureSource = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const dir=process.argv[2],role=process.argv[3]||'root';
fs.writeFileSync(path.join(dir,role+'.tmp'),JSON.stringify({pid:process.pid,parentPid:process.ppid}));
fs.renameSync(path.join(dir,role+'.tmp'),path.join(dir,role+'.json'));
if(role==='root') {
 let spawned=false;
 setInterval(()=>{
  if(!spawned&&fs.existsSync(path.join(dir,'spawn'))){spawned=true;spawn(process.execPath,[__filename,dir,'middle'],{stdio:'ignore'});}
  if(fs.existsSync(path.join(dir,'leave-root')))process.exit(0);
 },5);
} else if(role==='middle') {
 spawn(process.execPath,[__filename,dir,'leaf'],{stdio:'ignore',detached:true});
 setInterval(()=>{if(fs.existsSync(path.join(dir,'leave-middle')))process.exit(0);},5);
} else setInterval(()=>fs.writeFileSync(path.join(dir,role+'.heartbeat'),String(Date.now())),15);
`;

describe.skipIf(process.platform !== "win32")("native Windows review Job ownership", () => {
  it.each(["late child", "root already exited"])("stops owned %s across a vanished intermediate and leaves a bystander alive", async scenario => {
    const root = await mkdtemp(path.join(directory, "tree-")), script = path.join(root, "tree.cjs"), wrapper = path.join(root, "target.cmd");
    await writeFile(script, fixtureSource);
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" "${root}"\r\n`);
    const api = await loadWindowsJobKernel();
    const koffi = await import("koffi");
    const terminateProcess = koffi.load("kernel32.dll").func("int __stdcall TerminateProcess(void *process, uint32_t code)");
    const observed: Array<{ role: string; pid: number; birth: string; handle: unknown }> = [];
    const capture = (role: string, pid: number) => {
      const handle = api.open(pid);
      if (handle === null) throw new Error("Native fixture disappeared before independent observation.");
      const member = { role, pid, birth: "unobserved", handle }; observed.push(member);
      const identity = api.identity(handle); member.birth = identity.birth.toString();
      expect(identity.pid).toBe(pid); expect(api.signaled(handle)).toBe(false);
      return handle;
    };
    const declaration = async (role: string): Promise<number> => {
      const file = path.join(root, role + ".json"); await until(() => existsSync(file));
      return (JSON.parse(await readFile(file, "utf8")) as { pid: number }).pid;
    };
    let bystander: ChildProcess | undefined, bystanderClosed = false;
    let job: unknown, jobClosed = false, phaseClosed = false, primary: unknown;
    const events: unknown[] = [];
    const record = (stage: string) => events.push({ stage, atNs: process.hrtime.bigint().toString(), members: observed.map(member => ({ role: member.role, pid: member.pid, birth: member.birth, signaled: api.signaled(member.handle) })) });
    let phase: ReturnType<typeof spawnWindowsReviewPhase> | undefined;
    try {
      bystander = spawn(process.execPath, [script, root, "bystander"], { stdio: "ignore", windowsHide: true });
      bystander.once("close", () => { bystanderClosed = true; });
      await once(bystander, "spawn");
      const bystanderPid = await declaration("bystander"), bystanderHandle = capture("bystander", bystanderPid);
      let capturedBeforeTermination: number[] = [];
      phase = spawnWindowsReviewPhase({ file: wrapper, args: [], cwd: root, environment: process.env, deadline: performance.now() + 15_000, graceMs: 5_000 }, {
        createScope: () => createWindowsReviewJobScope({ ...api,
          create: name => { job = api.create(name); return job; },
          // A synthetic stale-list entry exercises IsProcessInJob on a real
          // unrelated object; it does not claim native PID reuse was reproduced.
          inspect: handle => { const pids = [...api.inspect(handle)]; capturedBeforeTermination = pids; return [...pids, bystanderPid]; },
          close: handle => { api.close(handle); jobClosed = true; },
          terminate: handle => {
            if (scenario === "late child") {
              writeFileSync(path.join(root, "spawn"), "release");
              const deadline = performance.now() + 10_000;
              const wait = (check: () => boolean) => { while (!check()) { if (performance.now() >= deadline) throw new Error("Late-child native barrier timed out."); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
              wait(() => existsSync(path.join(root, "middle.json")) && existsSync(path.join(root, "leaf.json")));
              const middlePid = JSON.parse(readFileSync(path.join(root, "middle.json"), "utf8")).pid as number;
              const leafPid = JSON.parse(readFileSync(path.join(root, "leaf.json"), "utf8")).pid as number;
              const middle = capture("middle", middlePid), leaf = capture("leaf", leafPid);
              expect(capturedBeforeTermination).not.toContain(leafPid);
              expect(api.contains(handle, leaf)).toBe(true);
              writeFileSync(path.join(root, "leave-middle"), "release"); wait(() => api.signaled(middle));
              record("middle-exited-before-job");
              expect(api.signaled(leaf)).toBe(false);
              const heartbeat = path.join(root, "leaf.heartbeat"); let before = 0;
              wait(() => existsSync(heartbeat) && (before = Number(readFileSync(heartbeat, "utf8"))) > 0);
              wait(() => { expect(api.signaled(leaf)).toBe(false); return Number(readFileSync(heartbeat, "utf8")) > before; });
              expect(api.contains(handle, leaf)).toBe(true);
              expect(api.signaled(leaf)).toBe(false);
            }
            record("before-terminate-job"); api.terminate(handle); record("terminate-return");
          },
        }),
      });
      void phase.closed.then(() => { phaseClosed = true; });
      phase.child.stdin!.end(); phase.child.stdout!.resume(); phase.child.stderr!.resume();
      await once(phase.child, "spawn"); capture("guardian", phase.child.pid!);
      await phase.start();
      const target = capture("root", await declaration("root"));
      expect(api.contains(job, target)).toBe(true);
      expect(api.contains(job, bystanderHandle)).toBe(false);
      record("admitted-target");
      if (scenario === "root already exited") {
        writeFileSync(path.join(root, "spawn"), "release");
        const middle = capture("middle", await declaration("middle")), leaf = capture("leaf", await declaration("leaf"));
        expect(api.contains(job, leaf)).toBe(true);
        writeFileSync(path.join(root, "leave-middle"), "release"); await until(() => api.signaled(middle));
        expect(api.signaled(leaf)).toBe(false);
        writeFileSync(path.join(root, "leave-root"), "release"); await until(() => phaseClosed);
        expect(phase.result).toMatchObject({ code: 0, signal: null, failure: null });
        expect(api.signaled(target)).toBe(true);
        expect(api.signaled(leaf)).toBe(false);
        const heartbeat = path.join(root, "leaf.heartbeat"); let before = 0;
        await until(() => existsSync(heartbeat) && (before = Number(readFileSync(heartbeat, "utf8"))) > 0);
        await until(() => { expect(api.signaled(leaf)).toBe(false); return Number(readFileSync(heartbeat, "utf8")) > before; });
        expect(api.contains(job, leaf)).toBe(true);
        expect(api.signaled(leaf)).toBe(false);
        record("root-close-with-live-leaf");
      }
      await phase.stop(); record("stop-return");
      expect(observed.filter(member => member.role !== "bystander").every(member => api.signaled(member.handle))).toBe(true);
      expect(api.signaled(bystanderHandle)).toBe(false);
      const heartbeat = path.join(root, "bystander.heartbeat"); await until(() => existsSync(heartbeat));
      const before = await readFile(heartbeat, "utf8"); await until(async () => (await readFile(heartbeat, "utf8")) !== before);
    } catch (error) { primary = error; throw error; }
    finally {
      const cleanup: unknown[] = [];
      try { if (!jobClosed && job !== undefined) api.terminate(job); } catch (error) { cleanup.push(error); }
      for (const member of observed) try { if (!api.signaled(member.handle) && !terminateProcess(member.handle, 1) && !api.signaled(member.handle)) throw new Error("Independent native fixture termination failed."); } catch (error) { cleanup.push(error); }
      if (phase !== undefined && !phaseClosed) phase.child.kill("SIGKILL"); if (bystander !== undefined && !bystanderClosed) bystander.kill("SIGKILL");
      try { await until(() => (phase === undefined || phaseClosed) && (bystander === undefined || bystanderClosed) && observed.every(member => api.signaled(member.handle))); record("cleanup-complete"); } catch (error) { cleanup.push(error); }
      for (const member of observed) try { api.closeProcess(member.handle); } catch (error) { cleanup.push(error); }
      if (!jobClosed && job !== undefined) try { api.close(job); } catch (error) { cleanup.push(error); }
      console.error("WINDOWS_REVIEW_JOB_DIAGNOSTIC " + JSON.stringify({ scenario, primaryError: primary === undefined ? null : String(primary), cleanupErrors: cleanup.map(String), events }));
      if (cleanup.length) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup], "Native Job fixture cleanup failed.");
    }
  }, 45_000);

  it("kills the admitted ordinary descendants when the last Job owner dies", async () => {
    const root = await mkdtemp(path.join(directory, "owner-loss-")), script = path.join(root, "tree.cjs");
    await writeFile(script, fixtureSource);
    const api = await loadWindowsJobKernel(), koffi = await import("koffi");
    const terminateProcess = koffi.load("kernel32.dll").func("int __stdcall TerminateProcess(void *process, uint32_t code)");
    const observed: Array<{ role: string; handle: unknown }> = [];
    let owner: ChildProcess | undefined, ownerClosed = false, primary: unknown, ownerError = "";
    const capture = async (role: string): Promise<unknown> => {
      const file = path.join(root, role + ".json"); await until(() => { if (ownerClosed) throw new Error("Native Job owner exited before fixture declaration: " + ownerError); return existsSync(file); });
      const { pid } = JSON.parse(await readFile(file, "utf8")) as { pid: number };
      const handle = api.open(pid);
      if (handle === null) throw new Error("Owner-loss fixture disappeared before independent capture.");
      observed.push({ role, handle }); expect(api.identity(handle).pid).toBe(pid); expect(api.signaled(handle)).toBe(false);
      return handle;
    };
    try {
      const module = new URL("../../../dist/commands/review/windows-phase.js", import.meta.url).href;
      const source = `import {spawnWindowsReviewPhase} from ${JSON.stringify(module)};
import {writeFileSync} from 'node:fs';
const phase=spawnWindowsReviewPhase({file:process.execPath,args:[${JSON.stringify(script)},${JSON.stringify(root)}],cwd:${JSON.stringify(root)},environment:process.env,deadline:performance.now()+15000,graceMs:5000});
phase.child.stdin.end();phase.child.stdout.resume();phase.child.stderr.resume();
await phase.start();writeFileSync(${JSON.stringify(path.join(root, "guardian.json"))},JSON.stringify({pid:phase.child.pid}));
setInterval(()=>{},1000);`;
      owner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      owner.stderr!.on("data", chunk => { ownerError = (ownerError + String(chunk)).slice(-8192); });
      owner.once("error", error => { ownerError = String(error); });
      owner.once("close", () => { ownerClosed = true; });
      await capture("guardian"); await capture("root");
      writeFileSync(path.join(root, "spawn"), "release"); await capture("middle"); const leaf = await capture("leaf");
      owner.kill("SIGKILL"); await until(() => ownerClosed && observed.every(member => api.signaled(member.handle)));
      expect(api.signaled(leaf)).toBe(true);
    } catch (error) { primary = error; throw error; }
    finally {
      const cleanup: unknown[] = [];
      if (owner !== undefined && !ownerClosed) owner.kill("SIGKILL");
      for (const member of observed) try { if (!api.signaled(member.handle) && !terminateProcess(member.handle, 1) && !api.signaled(member.handle)) throw new Error("Owner-loss fixture cleanup failed."); } catch (error) { cleanup.push(error); }
      try { await until(() => (owner === undefined || ownerClosed) && observed.every(member => api.signaled(member.handle))); } catch (error) { cleanup.push(error); }
      for (const member of observed) try { api.closeProcess(member.handle); } catch (error) { cleanup.push(error); }
      if (cleanup.length) throw new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup], "Owner-loss native cleanup remains unconfirmed.");
    }
  }, 45_000);

  it.each(["assignment", "membership"])("does not release real target code after %s fails", async failure => {
    const api = await loadWindowsJobKernel(), marker = path.join(directory, `forbidden-${failure}`);
    const phase = spawnWindowsReviewPhase({ file: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
      cwd: directory, environment: process.env, deadline: performance.now() + 10_000, graceMs: 3_000 }, {
      createScope: () => createWindowsReviewJobScope({ ...api,
        assignHandle: (job, process) => api.assignHandle(failure === "assignment" ? null : job, process),
        contains: (job, process) => failure !== "membership" && api.contains(job, process),
      }),
    });
    phase.child.stdin!.end(); phase.child.stdout!.resume(); phase.child.stderr!.resume();
    try { await expect(phase.start()).rejects.toThrow(); }
    finally { await phase.stop(); }
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});
