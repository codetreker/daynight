import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { captureProcessProof, inspectProcessProof, stopControllerProcesses, confirmControllerProcessesStopped, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
const children: ChildProcess[] = [];
afterEach(() => vi.unstubAllEnvs());
afterEach(async () => { for (const child of children.splice(0)) if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } });
const launch = async (): Promise<{ child: ChildProcess; descendant: number }> => {
  const child = spawn(process.execPath, ["-e", 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(c.pid)+"\\n");setInterval(()=>{},1000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] }); children.push(child);
  const descendant = await new Promise<number>((resolve,reject) => { child.once("error",reject); child.stdout!.once("data",data => resolve(Number(String(data).trim()))); });
  return { child, descendant };
};
it.skipIf(process.platform === "win32")("stops the attributed controller group and waits for its descendant to exit", async () => {
  const { child, descendant } = await launch(); const parent = await captureProcessProof(child.pid!); const native = await captureProcessProof(descendant);
  expect(parent.processGroupId).toBe(parent.pid); expect(native.processGroupId).toBe(parent.pid);
  expect(await confirmControllerProcessesStopped(parent, [native])).toBe(false);
  await stopControllerProcesses(parent, [native], Date.now()+5000);
  expect(await confirmControllerProcessesStopped(parent, [native])).toBe(true);
});
it.skipIf(process.platform === "win32")("does not signal a group when the recorded process instance does not match", async () => {
  const { child } = await launch(); const parent = await captureProcessProof(child.pid!); const replaced = { ...parent, commandHash: "different" };
  expect(await inspectProcessProof(replaced)).toBe("replaced");
  await expect(stopControllerProcesses(replaced, [], Date.now()+1000)).rejects.toThrow(/no original/);
  expect(await inspectProcessProof(parent)).toBe("running");
  await stopControllerProcesses(parent, [], Date.now()+5000);
});
it.skipIf(process.platform === "win32")("keeps process identity and cleanup stable under a localized terminal environment", async () => {
  const { child, descendant } = await launch();
  vi.stubEnv("LC_ALL", "C");
  const controller = await captureProcessProof(child.pid!);
  const native = await captureProcessProof(descendant);
  for (const locale of ["zh_CN.UTF-8", "zh_TW.UTF-8"]) {
    vi.stubEnv("LC_ALL", locale);
    expect(await captureProcessProof(child.pid!)).toEqual(controller);
    expect(await inspectProcessProof(controller)).toBe("running");
    expect(process.env.LC_ALL).toBe(locale);
  }
  await stopControllerProcesses(controller, [native], Date.now() + 5000);
  expect(await confirmControllerProcessesStopped(controller, [native])).toBe(true);
  expect(process.env.LC_ALL).toBe("zh_TW.UTF-8");
});
it.skipIf(process.platform === "win32")("recognizes the original exited child while its parent has not reaped the zombie", async () => {
  const script = 'import os,sys,time\nr,w=os.pipe()\npid=os.fork()\nif pid == 0:\n os.close(w); os.read(r,1); os._exit(0)\nos.close(r); print(pid,flush=True); sys.stdin.buffer.read(1); os.write(w,b"x"); time.sleep(20)';
  const parent = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "ignore"] }); children.push(parent);
  const pid = await new Promise<number>((resolve, reject) => { parent.once("error", reject); parent.stdout!.once("data", data => resolve(Number(String(data).trim()))); });
  const proof = await captureProcessProof(pid);
  parent.stdin!.write("x");
  const deadline = Date.now() + 5000;
  let state = await inspectProcessProof(proof);
  while (state === "running" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); state = await inspectProcessProof(proof); }
  expect(state).toBe("stopped");
  expect(() => process.kill(pid, 0)).not.toThrow();
}, 10_000);
it.skipIf(process.platform === "win32")("recognizes the original child after its parent exits and it is reparented", async () => {
  const script = 'import os,sys,time\npid=os.fork()\nif pid == 0:\n os.close(0); os.close(1); time.sleep(20); os._exit(0)\nprint(pid,flush=True); sys.stdin.buffer.read(1); os._exit(0)';
  const parent = spawn("python3", ["-c", script], { detached: true, stdio: ["pipe", "pipe", "ignore"] }); children.push(parent);
  const [data] = await once(parent.stdout!, "data", { signal: AbortSignal.timeout(5000) });
  const pid = Number(String(data).trim());
  let proof: ProcessProof | undefined;
  try {
    proof = await captureProcessProof(pid);
    expect(proof.parentPid).toBe(parent.pid);
    const parentClosed = once(parent, "close", { signal: AbortSignal.timeout(5000) });
    parent.stdin!.write("x"); await parentClosed;
    const deadline = Date.now() + 5000;
    let reparented = await captureProcessProof(pid);
    while (reparented.parentPid === proof.parentPid && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25)); reparented = await captureProcessProof(pid);
    }
    expect(reparented.parentPid).not.toBe(proof.parentPid);
    expect(reparented.startedAt).toBe(proof.startedAt);
    expect(reparented.processGroupId).toBe(proof.processGroupId);
    process.kill(pid, "SIGTERM");
    let state = await inspectProcessProof(proof);
    while (state !== "stopped" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); state = await inspectProcessProof(proof); }
    expect(state).toBe("stopped");
  } finally {
    if (proof !== undefined && await inspectProcessProof(proof) === "running") {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
  }
}, 15_000);
