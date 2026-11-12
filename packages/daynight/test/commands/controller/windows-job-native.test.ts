import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { captureProcessProof, confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { acquireControllerJobLease, createControllerJob, inspectControllerJob, inspectControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";

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
  const pointerSize = koffi.sizeof("uintptr_t");
  const inventory = (): number[] => {
    if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported fixture Job pointer size.");
    const data = Buffer.alloc(262_144);
    if (query(job, 3, data, data.length, null) === 0) throw new Error(`Fixture Job query failed (Win32 ${lastError()}).`);
    const assigned = data.readUInt32LE(0), count = data.readUInt32LE(4);
    if (count > assigned || 8 + count * pointerSize > data.length) throw new Error("Invalid fixture Job inventory size.");
    const pids = Array.from({ length: count }, (_, index) => {
      const offset = 8 + index * pointerSize;
      return pointerSize === 8 ? Number(data.readBigUInt64LE(offset)) : data.readUInt32LE(offset);
    });
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid fixture Job process identity.");
    return pids.sort((a, b) => a - b);
  };
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
    await vi.waitFor(async () => {
      const expected = inventory();
      expect(expected).toContain(leader!.pid);
      expect(expected).toContain(descendant!.pid);
      expect([...(await inspectControllerJob(name))].sort((a, b) => a - b)).toEqual(expected);
    }, { timeout: 10_000, interval: 25 });
    await inspectControllerJob(name, true, Date.now() + 15_000, [leader, descendant]);
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
      await vi.waitFor(() => expect(inventory()).toEqual([]), { timeout: 10_000, interval: 25 });
      if (descendant !== undefined) await vi.waitFor(async () => expect(await inspectProcessProof(descendant!)).toBe("stopped"), { timeout: 10_000, interval: 25 });
    } catch (error) { cleanupFailures.push(error); }
    try { if (close(job) === 0) throw new Error(`Fixture Job handle release failed (Win32 ${lastError()}).`); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length > 0) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "Native Job fixture cleanup failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
}, 90_000);

test.skipIf(process.platform !== "win32").each([true, false])("handles an unrecorded descendant after Controller exit (lease retained: %s)", async retain => {
  const koffi = await import("koffi"), library = koffi.load("kernel32.dll");
  const create = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const openProcess = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const assign = library.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const terminate = library.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const launchId = randomUUID(), name = `Local\\Daynight-${launchId}`;
  let job: unknown = create(null, name), lease: ControllerJobLease | undefined;
  if (job === null) throw new Error(`Fixture Job creation failed (Win32 ${lastError()}).`);
  const script = `
const { spawn } = require('node:child_process');
process.on('message', () => {
  // Avoid libuv's parent-lifetime Job while keeping the inherited Controller Job.
  // https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c#L69-L80
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(()=>{},1000)'], { stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true, detached: true });
  child.once('message', () => process.send({ pid: child.pid }));
});
process.send('ready'); setInterval(()=>{},1000);
`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) }); void closed.catch(() => {});
  let descendant: ProcessProof | undefined, failure: unknown, failed = false;
  const cleanupFailures: unknown[] = [];
  try {
    await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    const original = await captureProcessProof(child.pid!);
    const processHandle: unknown = openProcess(0x101, 0, child.pid!);
    if (processHandle === null) throw new Error(`Fixture process opening failed (Win32 ${lastError()}).`);
    try { if (assign(job, processHandle) === 0) throw new Error(`Fixture Job assignment failed (Win32 ${lastError()}).`); }
    finally { if (close(processHandle) === 0) throw new Error(`Fixture process handle close failed (Win32 ${lastError()}).`); }
    if (retain) lease = await acquireControllerJobLease(launchId, original, Date.now() + 15_000);
    const next = once(child, "message", { signal: AbortSignal.timeout(10_000) }); child.send("spawn");
    const [receipt] = await next as [{ pid: number }]; descendant = await captureProcessProof(receipt.pid);
    if (close(job) === 0) throw new Error(`Fixture Job close failed (Win32 ${lastError()}).`);
    job = null;
    if (!child.kill()) throw new Error("Fixture Controller termination failed.");
    await closed;
    expect(await inspectProcessProof(descendant)).toBe("running");
    const complete = { ...original, jobObjectName: name };
    if (lease !== undefined) {
      expect(await inspectControllerJobLease(lease, complete, false, Date.now() + 15_000)).toContain(descendant.pid);
      await stopControllerProcesses(complete, [], Date.now() + 15_000, lease);
      await vi.waitFor(async () => expect(await inspectProcessProof(descendant!)).toBe("stopped"), { timeout: 10_000, interval: 25 });
      expect(await confirmControllerProcessesStopped(complete, [], Date.now() + 15_000, lease)).toBe(true);
    } else {
      await expect(inspectControllerJob(name)).rejects.toMatchObject({ stage: "open", win32Code: 2 });
      await expect(confirmControllerProcessesStopped(complete, [], Date.now() + 15_000)).rejects.toThrow(/lease is unavailable/);
      await expect(stopControllerProcesses(complete, [], Date.now() + 15_000)).rejects.toThrow(/lease is unavailable/);
      expect(await inspectProcessProof(descendant)).toBe("running");
    }
  } catch (error) { failed = true; failure = error; }
  finally {
    if (job !== null) try { if (terminate(job, 1) === 0) throw new Error(`Fixture Job termination failed (Win32 ${lastError()}).`); } catch (error) { cleanupFailures.push(error); }
    if (descendant !== undefined) try {
      if (await inspectProcessProof(descendant) === "running") await stopControllerBootstrap(descendant, Date.now() + 10_000);
      await vi.waitFor(async () => expect(await inspectProcessProof(descendant!)).toBe("stopped"), { timeout: 10_000, interval: 25 });
    } catch (error) { cleanupFailures.push(error); }
    try { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; } catch (error) { cleanupFailures.push(error); }
    if (lease !== undefined) try { releaseControllerJobLease(lease); } catch (error) { cleanupFailures.push(error); }
    if (job !== null) try { if (close(job) === 0) throw new Error(`Fixture Job close failed (Win32 ${lastError()}).`); } catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length > 0) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "Retained Job fixture cleanup failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
}, 60_000);

test.skipIf(process.platform !== "win32")("observes whether a live member retains a Job name after the last handle closes", async () => {
  const koffi = await import("koffi"), library = koffi.load("kernel32.dll");
  const open = library.func("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) }); void closed.catch(() => {});
  let reopened: unknown = null, failure: unknown, failed = false;
  const cleanupFailures: unknown[] = [];
  try {
    await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
    const proof = await captureProcessProof(child.pid!);
    const name = await createControllerJob(randomUUID(), child.pid!);
    expect(await inspectProcessProof(proof)).toBe("running");
    reopened = open(4, 0, name);
    if (reopened === null) {
      const code = lastError();
      console.info(`Live-member Job name after last handle close: unavailable (Win32 ${code}).`);
      expect(code).toBe(2);
      await expect(inspectControllerJob(name)).rejects.toMatchObject({ stage: "open", win32Code: 2 });
    } else {
      console.info("Live-member Job name after last handle close: available.");
      expect(await inspectControllerJob(name)).toContain(child.pid);
    }
    expect(await inspectProcessProof(proof)).toBe("running");
  } catch (error) { failed = true; failure = error; }
  finally {
    if (reopened !== null) try { if (close(reopened) === 0) throw new Error(`Fixture Job close failed (Win32 ${lastError()}).`); } catch (error) { cleanupFailures.push(error); }
    try { if (child.exitCode === null && child.signalCode === null && !child.kill()) throw new Error("Fixture process termination failed."); await closed; }
    catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length > 0) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "Job name fixture cleanup failed.", failed ? { cause: failure } : undefined);
  if (failed) throw failure;
}, 60_000);

test.skipIf(process.platform !== "win32")("does not terminate a real replacement Job created under the old name", async () => {
  const koffi = await import("koffi"), library = koffi.load("kernel32.dll");
  const create = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const openProcess = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const assign = library.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const terminate = library.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const getError = library.func("uint32_t __stdcall GetLastError()");
  const setError = library.func("void __stdcall SetLastError(uint32_t code)");
  const name = `Local\\Daynight-${randomUUID()}`;
  const children: { child: ReturnType<typeof spawn>; closed: Promise<unknown> }[] = [];
  let firstJob: unknown = null, secondJob: unknown = null;
  const start = async () => {
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) });
    children.push({ child, closed });
    await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
    return child;
  };
  const attach = (job: unknown, pid: number) => {
    const processHandle: unknown = openProcess(0x101, 0, pid);
    if (processHandle === null) throw new Error(`Fixture process opening failed (Win32 ${getError()}).`);
    try { if (assign(job, processHandle) === 0) throw new Error(`Fixture Job assignment failed (Win32 ${getError()}).`); }
    finally { if (close(processHandle) === 0) throw new Error(`Fixture process handle close failed (Win32 ${getError()}).`); }
  };
  try {
    firstJob = create(null, name);
    if (firstJob === null) throw new Error(`Original fixture Job creation failed (Win32 ${getError()}).`);
    const first = await start(); attach(firstJob, first.pid!);
    const original = await captureProcessProof(first.pid!);
    if (terminate(firstJob, 1) === 0) throw new Error(`Original fixture Job termination failed (Win32 ${getError()}).`);
    await children[0]!.closed;
    if (close(firstJob) === 0) throw new Error(`Original fixture Job close failed (Win32 ${getError()}).`);
    firstJob = null;
    setError(0);
    secondJob = create(null, name);
    if (secondJob === null || getError() === 183) throw new Error("Replacement fixture Job was not independently created.");
    const replacement = await start(); attach(secondJob, replacement.pid!);
    const current = await captureProcessProof(replacement.pid!);
    expect(current.startedAt).not.toBe(original.startedAt);
    // Model PID reuse while keeping the old birth and command evidence.
    await expect(inspectControllerJob(name, true, Date.now() + 15_000, [{ ...original, pid: replacement.pid! }])).rejects.toThrow(/no verified original/);
    expect(await inspectProcessProof(current)).toBe("running");
  } finally {
    const failures: unknown[] = [];
    for (const job of [firstJob, secondJob]) if (job !== null) {
      try { if (terminate(job, 1) === 0) throw new Error(`Fixture Job termination failed (Win32 ${getError()}).`); }
      catch (error) { failures.push(error); }
    }
    for (const { child, closed } of children) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
      catch (error) { failures.push(error); }
    }
    for (const job of [firstJob, secondJob]) if (job !== null) try { if (close(job) === 0) throw new Error(`Fixture Job close failed (Win32 ${getError()}).`); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Replacement Job fixture cleanup failed.");
  }
}, 60_000);
