import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { captureProcessProof, inspectProcessProof, stopControllerProcesses, confirmControllerProcessesStopped } from "../../../src/commands/controller/process-proof.js";
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
