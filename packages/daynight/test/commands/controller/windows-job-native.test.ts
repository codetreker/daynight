import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { captureProcessProof, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { createControllerJob, inspectControllerJob } from "../../../src/commands/controller/windows-job.js";

test.skipIf(process.platform !== "win32")("queries and terminates a real named Job containing a leader and its descendant", async () => {
  const koffi = await import("koffi"), library = koffi.load("kernel32.dll");
  const create = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const openProcess = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const assign = library.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const query = library.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)");
  const terminate = library.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const launchId = randomUUID(), name = `Local\\Daynight-${launchId}`;
  // The test owns a separate handle so the namespace remains available to each
  // production observation; membership references alone retain only the body.
  // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmaketemporaryobject
  const job: unknown = create(null, name);
  if (job === null) throw new Error(`Fixture Job creation failed (Win32 ${lastError()}).`);
  const script = `
import { spawn } from 'node:child_process';
process.on('message', message => {
  if (message !== 'spawn') return;
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  child.on('error', error => { throw error; });
  child.once('message', () => process.send({ descendantPid: child.pid }));
});
process.send({ ready: true });
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  const closed = once(child, "close"); void closed.catch(() => {});
  const waitForClose = async () => {
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Fixture leader did not close.")), 10_000); timeout.unref();
      })]);
    } finally { clearTimeout(timeout!); }
  };
  let stderr = ""; child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { stderr += chunk; });
  let descendant: ProcessProof | undefined, leader: ProcessProof | undefined, assigned = false;
  let failure: unknown, failed = false;
  const cleanupFailures: unknown[] = [];
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    expect(ready).toEqual({ ready: true });
    leader = await captureProcessProof(child.pid!);
    const processHandle: unknown = openProcess(0x101, 0, child.pid!);
    if (processHandle === null) throw new Error(`Fixture process opening failed (Win32 ${lastError()}).`);
    try {
      if (assign(job, processHandle) === 0) throw new Error(`Fixture Job assignment failed (Win32 ${lastError()}).`);
      assigned = true;
    } finally { if (close(processHandle) === 0) throw new Error(`Fixture process handle release failed (Win32 ${lastError()}).`); }
    await expect(createControllerJob(launchId, child.pid!)).rejects.toMatchObject({ stage: "identity-already-exists", win32Code: 183 });
    const spawned = once(child, "message", { signal: AbortSignal.timeout(15_000) });
    child.send("spawn");
    const [receipt] = await spawned as [{ descendantPid: number }];
    descendant = await captureProcessProof(receipt.descendantPid);
    expect(descendant.parentPid).toBe(child.pid);
    expect(await inspectProcessProof(leader)).toBe("running");
    expect(await inspectProcessProof(descendant)).toBe("running");
    expect([...(await inspectControllerJob(name))].sort((a, b) => a - b)).toEqual([leader.pid, descendant.pid].sort((a, b) => a - b));
    await inspectControllerJob(name, true);
    await waitForClose();
    await vi.waitFor(async () => {
      expect(await inspectProcessProof(leader!)).toBe("stopped");
      expect(await inspectProcessProof(descendant!)).toBe("stopped");
      expect(await inspectControllerJob(name)).toEqual([]);
    }, { timeout: 10_000, interval: 25 });
    expect(stderr).toBe("");
  } catch (error) { failed = true; failure = error; }
  finally {
    try {
      if (assigned && terminate(job, 1) === 0) throw new Error(`Fixture Job termination failed (Win32 ${lastError()}).`);
    } catch (error) { cleanupFailures.push(error); }
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForClose();
      await vi.waitFor(() => {
        const data = Buffer.alloc(262_144);
        if (query(job, 3, data, data.length, null) === 0) throw new Error(`Fixture Job query failed (Win32 ${lastError()}).`);
        expect(data.readUInt32LE(4)).toBe(0);
      }, { timeout: 10_000, interval: 25 });
      if (descendant !== undefined) await vi.waitFor(async () => expect(await inspectProcessProof(descendant!)).toBe("stopped"), { timeout: 10_000, interval: 25 });
    } catch (error) { cleanupFailures.push(error); }
    try { if (close(job) === 0) throw new Error(`Fixture Job handle release failed (Win32 ${lastError()}).`); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length > 0) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "Native Job fixture cleanup failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
}, 90_000);
