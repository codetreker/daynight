import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import type { WindowsNamedJobKernel } from "../../../src/platform/windows-job.js";
import type { HerdrToolLaunchManifest } from "../../../src/commands/worker/herdr/tool-launch-protocol.js";
import { establishCurrentHerdrHelperJob, retainHerdrJobObserver } from "../../../src/commands/worker/herdr/tool-launch-windows-job.js";

const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
const owner = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", claimId: "00000000-0000-4000-8000-000000000003", worktreeId: "00000000-0000-4000-8000-000000000004" };
const helperBirth = BigInt(Date.UTC(2026, 10, 12)) * 10000n + 116444736000000000n + 1234000n;
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/job-tests");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "owner-")); roots.push(directory);
  const operation = createOperation({ limits: { totalMs: 2000 } });
  const launch = frozenToolLaunch("codex", "herdr");
  const manifest: HerdrToolLaunchManifest = { schemaVersion: 1, owner, nonce: randomUUID(), launch, nativePath: null, nodeExecutable: process.execPath, childEntry: import.meta.filename, platform: "win32" };
  const manifestPath = path.join(directory, "manifest.json"), file = path.join(directory, "windows-job.json"), native = 501001, detached = 501002;
  const alive = new Set([process.pid, native]), associated = new Set([process.pid, native, detached]);
  const job = { kind: "job" }, calls: string[] = [];
  let present = true, activeOverride: number | undefined;
  const api: WindowsNamedJobKernel = {
    create: () => { calls.push("create"); return job; },
    killOnClose: () => { calls.push("configure"); },
    assignHandle: () => { calls.push("assign"); },
    assign: () => { throw new Error("PID-only assignment is outside this fixture."); },
    openNamed: () => { calls.push("open-job"); return present ? job : null; },
    open: pid => { calls.push(`open:${pid}`); return associated.has(pid) ? { pid, parentPid: pid === process.pid ? 77 : process.pid, birth: helperBirth + BigInt(pid === process.pid ? 0 : pid) } : null; },
    identity: handle => handle as { pid: number; parentPid: number; birth: bigint },
    contains: (_job, handle) => associated.has((handle as { pid: number }).pid),
    signaled: handle => !alive.has((handle as { pid: number }).pid),
    active: () => activeOverride ?? alive.size,
    inspect: () => [...alive],
    terminate: () => { calls.push("terminate"); alive.clear(); },
    close: () => { calls.push("close-job"); },
    closeProcess: handle => { calls.push(`close:${(handle as { pid: number }).pid}`); },
  };
  let observer: Awaited<ReturnType<typeof retainHerdrJobObserver>> | undefined;
  const bind = async () => observer = await retainHerdrJobObserver(manifestPath, manifest, { helperPid: process.pid }, operation, undefined, api);
  cleanup.push(async () => {
    alive.clear(); activeOverride = undefined;
    api.terminate = () => { alive.clear(); };
    if (observer !== undefined) { try { await observer.stop(operation); observer.release(); } catch { /* Failed synthetic bindings own no OS handles. */ } }
    operation.dispose();
  });
  return { directory, manifest, manifestPath, file, operation, api, calls, alive, native, detached, bind, setPresent: (value: boolean) => { present = value; }, setActive: (value?: number) => { activeOverride = value; } };
};
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("publishes the original boundary only after configuration and assignment while leaving the self-member handle to OS exit", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  expect(f.calls.filter(call => ["create", "configure", "assign", "close-job"].includes(call))).toEqual(["create", "configure", "assign"]);
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ schemaVersion: 1, nonce: f.manifest.nonce, owner, selectionKey: f.manifest.launch.selectionKey, helperPid: process.pid, helperParentPid: 77, helperBirth: helperBirth.toString(), policy: "kill-on-close" });
  expect(f.calls.at(-1)).toBe(`close:${process.pid}`);
});

it("closes an unassigned Job after configuration failure without publishing a boundary", async () => {
  const f = await fixture(), failure = new Error("controlled configuration failure");
  f.api.killOnClose = () => { throw failure; };
  await expect(establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api)).rejects.toBe(failure);
  expect(f.calls).toContain("close-job"); expect(f.calls).not.toContain("assign");
  await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains a potentially assigned self-member handle when assignment or boundary publication fails", async () => {
  const f = await fixture(), failure = new Error("controlled assignment failure");
  f.api.assignHandle = () => { throw failure; };
  await expect(establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api)).rejects.toBe(failure);
  expect(f.calls).not.toContain("close-job");
  f.api.assignHandle = () => {};
  await writeFile(f.file, "{}", { mode: 0o600 });
  await expect(establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api)).rejects.toMatchObject({ code: "EEXIST" });
  expect(f.calls).not.toContain("close-job"); expect(await readFile(f.file, "utf8")).toBe("{}");
});

it("keeps missing legacy boundaries and missing named Jobs unknown", async () => {
  const f = await fixture();
  await expect(f.bind()).rejects.toThrow("no kill-on-close boundary");
  expect(f.calls).not.toContain("open-job");
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  f.setPresent(false);
  await expect(f.bind()).rejects.toThrow("name is missing");
});

it("reuses one original observer across reconnects and requires its helper birth proof", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  const observer = await f.bind();
  expect(await f.bind()).toBe(observer); expect(f.calls.filter(call => call === "open-job")).toHaveLength(1);
  await expect(retainHerdrJobObserver(f.manifestPath, f.manifest, { helperPid: process.pid }, f.operation, { pid: process.pid, parentPid: 77, processGroupId: null, startedAt: "2026-11-12T00:00:00.1233000Z", commandHash: "a".repeat(64) }, f.api)).rejects.toThrow("birth differs");
  await observer.stop(f.operation); observer.release();
});

it("releases an unrelated named Job lease without terminating its members", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  f.api.contains = () => false;
  await expect(f.bind()).rejects.toThrow("does not contain");
  expect(f.calls).not.toContain("terminate"); expect(f.calls).toContain("close-job");
});

it("binds a signaled original helper when it exits after the second Job lease opens", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  vi.useFakeTimers();
  const open = f.api.openNamed;
  f.api.openNamed = name => { const job = open(name); f.alive.delete(process.pid); return job; };
  const observer = await f.bind();
  expect(f.calls.indexOf(`open:${process.pid}`, f.calls.indexOf("assign"))).toBeLessThan(f.calls.indexOf("open-job"));
  await vi.advanceTimersByTimeAsync(100);
  expect(f.calls).toContain("terminate"); expect(observer.stopped()).toBe(true); observer.release();
});

it("does not acquire a second Job lease when the original helper can no longer be held", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  f.api.open = () => null;
  await expect(f.bind()).rejects.toThrow("cannot bind");
  expect(f.calls).not.toContain("open-job");
});

it.each(["identity", "contains"] as const)("keeps failed %s observations outside the proven closed Job cohort", async stage => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  const observer = await f.bind(), identity = f.api.identity, contains = f.api.contains;
  f.alive.add(f.detached);
  if (stage === "identity") f.api.identity = handle => { if ((handle as { pid: number }).pid === f.detached) throw new Error("controlled identity failure"); return identity(handle); };
  else f.api.contains = (job, handle) => { if ((handle as { pid: number }).pid === f.detached) throw new Error("controlled membership failure"); return contains(job, handle); };
  expect(() => observer.captureForeground([f.detached], f.operation)).toThrow("controlled");
  f.api.identity = identity; f.api.contains = contains; f.alive.delete(f.detached);
  await observer.stop(f.operation);
  expect(observer.closedMember(f.detached)).toBe(false);
  const open = f.api.open;
  f.api.open = pid => { const handle = open(pid); return pid === f.detached && handle !== null ? { ...(handle as object), birth: helperBirth + 99n } : handle; };
  expect(observer.closedMember(f.detached)).toBe(false);
  observer.release();
});

it("rechecks membership before reusing a handle retained from an incomplete foreground capture", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  const observer = await f.bind(), contains = f.api.contains;
  f.alive.add(f.detached);
  f.api.contains = (job, handle) => { if ((handle as { pid: number }).pid === f.detached) throw new Error("controlled membership failure"); return contains(job, handle); };
  expect(() => observer.captureForeground([f.detached], f.operation)).toThrow("controlled");
  const query = vi.fn((_job: unknown, handle: unknown) => (handle as { pid: number }).pid !== f.detached); f.api.contains = query;
  observer.captureForeground([f.detached], f.operation);
  expect(query).toHaveBeenCalledOnce(); expect(f.calls).toContain(`close:${f.detached}`);
  f.alive.delete(f.detached); await observer.stop(f.operation);
  expect(observer.closedMember(f.detached)).toBe(false); observer.release();
});

it.each(["job", "process"] as const)("retains failed initial %s handle releases for close-only recovery before another binding", async stage => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  const contains = f.api.contains, close = f.api.close, closeProcess = f.api.closeProcess;
  const closeJob = vi.fn(close).mockImplementationOnce(() => { if (stage === "job") throw new Error("controlled Job close failure"); close({}); });
  const closeHelper = vi.fn(closeProcess).mockImplementationOnce(handle => { if (stage === "process") throw new Error("controlled process close failure"); closeProcess(handle); });
  f.api.close = closeJob; f.api.closeProcess = closeHelper; f.api.contains = () => false;
  await expect(f.bind()).rejects.toThrow("original handles were retained");
  expect(f.calls).not.toContain("terminate");
  f.api.contains = contains;
  const observer = await f.bind();
  expect(closeJob).toHaveBeenCalledTimes(stage === "job" ? 2 : 1);
  expect(closeHelper).toHaveBeenCalledTimes(stage === "process" ? 2 : 1);
  await observer.stop(f.operation); observer.release();
});

it("does not overwrite pending original handles when two initial bindings resume together", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  const contains = f.api.contains, close = f.api.close;
  f.api.contains = () => false;
  const closeJob = vi.fn(() => { throw new Error("controlled repeated Job close failure"); }); f.api.close = closeJob;
  const waiting: Array<(api: WindowsNamedJobKernel) => void> = [];
  Object.defineProperty(f.api, "then", { configurable: true, value: (resolve: (api: WindowsNamedJobKernel) => void) => {
    waiting.push(resolve);
    if (waiting.length === 2) {
      Reflect.deleteProperty(f.api, "then");
      for (const resume of waiting) resume(f.api);
    }
  } });
  const results = await Promise.allSettled([f.bind(), f.bind()]);
  expect(results.every(result => result.status === "rejected")).toBe(true);
  expect(f.calls.filter(call => call === "open-job")).toHaveLength(1);
  expect(closeJob).toHaveBeenCalledTimes(2);
  f.api.contains = contains; f.api.close = close;
  const observer = await f.bind();
  expect(f.calls.filter(call => call === "open-job")).toHaveLength(2);
  await observer.stop(f.operation); observer.release();
});

it("keeps helper-exit cleanup armed when the initial bound Job member query fails", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  vi.useFakeTimers();
  const initial = new Error("controlled initial member query failure");
  f.api.inspect = () => { throw initial; };
  await expect(f.bind()).rejects.toMatchObject({ cause: initial });
  const observer = await f.bind();
  expect(() => observer.check()).toThrow("ownership remains unknown");
  f.alive.add(f.detached); f.alive.delete(process.pid);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.calls.filter(call => call === "terminate")).toHaveLength(1);
  expect(f.alive.size).toBe(0);
  let failure: unknown;
  try { observer.check(); } catch (error) { failure = error; }
  expect((failure as Error).cause).toBeInstanceOf(AggregateError);
  expect(((failure as Error).cause as AggregateError).errors).toContain(initial);
  f.api.inspect = () => [];
  await observer.stop(f.operation); expect(observer.stopped()).toBe(true); observer.release();
});

it("observes the original helper handle dying and terminates late unregistered descendants without releasing the Job", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  vi.useFakeTimers();
  const observer = await f.bind();
  f.alive.add(f.detached); f.alive.delete(process.pid);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.calls).toContain(`open:${f.detached}`); expect(f.calls).toContain("terminate");
  expect(observer.stopped()).toBe(true); expect(f.calls).not.toContain("close-job");
  observer.release();
});

it("requires captured process handles to signal even after Job accounting reports zero", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  const observer = await f.bind(); f.setActive(0);
  expect(observer.stopped()).toBe(false); expect(() => observer.release()).toThrow("complete process closure");
  await observer.stop(f.operation); expect(observer.stopped()).toBe(true); observer.release();
});

it("retains a monitor failure without high frequency retries and permits explicit bounded cleanup to reprove closure", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  vi.useFakeTimers(); const observer = await f.bind(), failure = new Error("controlled termination failure");
  const terminate = vi.fn(() => { throw failure; }); f.api.terminate = terminate; f.alive.delete(process.pid);
  await vi.advanceTimersByTimeAsync(1000);
  expect(terminate).toHaveBeenCalledOnce(); expect(() => observer.check()).toThrow("ownership remains unknown");
  expect(f.calls).not.toContain("close-job");
  f.api.terminate = () => { f.alive.clear(); };
  await observer.stop(f.operation); expect(observer.stopped()).toBe(true); observer.release();
});

it("still terminates the bound Job when helper-exit member observation fails and retains the original uncertainty", async () => {
  const f = await fixture();
  await establishCurrentHerdrHelperJob(f.manifestPath, f.manifest, f.operation, f.api);
  vi.useFakeTimers(); const observer = await f.bind(), failure = new Error("controlled member query failure");
  f.api.inspect = () => { throw failure; }; f.alive.add(f.detached); f.alive.delete(process.pid);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls.filter(call => call === "terminate")).toHaveLength(1);
  expect(() => observer.check()).toThrow("ownership remains unknown");
  expect(f.calls).not.toContain("close-job");
  f.api.inspect = () => [];
  await observer.stop(f.operation); expect(observer.stopped()).toBe(true); observer.release();
});
