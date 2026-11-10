import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnWindowsNativeCommand } from "../../src/platform/windows-native-command.js";
import { WindowsCommandCleanupError, restoreWindowsSpawnError } from "../../src/platform/windows-owned-command.js";
import type { WindowsNativeCommandOptions } from "../../src/platform/windows-owned-command.js";
import type { WindowsCommandJobKernel } from "../../src/platform/windows-job.js";
import type { WindowsNativeProcessKernel } from "../../src/platform/windows-native-process.js";
import { WindowsNativeProcessError } from "../../src/platform/windows-native-process.js";

let directory: string, pipeIndex = 0;
beforeAll(async () => { const root = path.resolve(import.meta.dirname, "../../../../.tmp"); await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, "native-owner-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const collect = async (stream: Readable): Promise<Buffer> => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
type Pipe = { kind: "pipe"; socket: Socket; inherited: boolean };
const fixture = () => {
  const job = {}, root = {}, thread = {}, observation = {}, clients: Pipe[] = [], accepted: Socket[] = [], events: string[] = [];
  let created = false, exited = false, code = 0, closeKills = true;
  const transportErrors: Error[] = [];
  const endOutputs = (out = Buffer.from([0, 1, 255]), err = Buffer.from("target stderr")): void => { clients[0]!.socket.end(out); clients[1]!.socket.end(err); };
  const jobs: WindowsCommandJobKernel = {
    create: vi.fn(() => { throw new Error("Named Job unexpected."); }), createAnonymousJob: vi.fn(() => job),
    killOnClose: vi.fn(), sealAdmissions: vi.fn(() => { events.push("seal"); }), clearKillOnClose: vi.fn(() => { events.push("OFF"); closeKills = false; }), restoreKillOnClose: vi.fn(),
    open: vi.fn(() => { throw new Error("Original native root must not be reopened by PID."); }), identity: vi.fn(() => ({ pid: 1234, parentPid: process.pid, birth: 456n })),
    assign: vi.fn(), assignHandle: vi.fn(), contains: vi.fn(() => true), inspect: vi.fn(() => created ? [1234] : []), signaled: vi.fn(() => exited), active: vi.fn(() => !created || exited ? 0 : 1), closeProcess: vi.fn(),
    terminate: vi.fn(() => { events.push("terminate"); exited = true; if (created && clients.length === 2) endOutputs(Buffer.alloc(0), Buffer.alloc(0)); }),
    close: vi.fn(() => { events.push("job-close"); if (closeKills && !exited) { exited = true; if (clients.length === 2) endOutputs(Buffer.alloc(0), Buffer.alloc(0)); } }),
  };
  const native: WindowsNativeProcessKernel = {
    environmentValue: () => undefined, compareOrdinal: (a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() === b.toUpperCase() ? 0 : 1,
    needCurrentDirectory: () => true, fileExists: () => true, shortPath: value => value,
    openPipeClient: name => { const client: Pipe = { kind: "pipe", socket: connect(name), inherited: false }; client.socket.on("error", error => { transportErrors.push(error); }); clients.push(client); return client; },
    serverPid: () => process.pid, write: (handle, bytes) => { (handle as Pipe).socket.write(bytes); }, openNullInput: () => ({ kind: "null" }),
    createSuspended: vi.fn(input => { created = true; events.push("create"); for (const handle of [input.stdin, input.stdout, input.stderr]) { if ((handle as Pipe).kind === "pipe") (handle as Pipe).inherited = true; native.close(handle); } return { created: { process: root, thread, pid: 1234, threadId: 4321 }, failure: undefined, cleanupErrors: [] }; }),
    duplicateProcess: vi.fn(() => observation), signaled: vi.fn(() => exited), exitCode: vi.fn(() => code), resume: vi.fn(() => { events.push("resume"); }),
    close: vi.fn(handle => { if (handle === root) events.push("root-close"); else if (handle === thread) events.push("thread-close"); else if ((handle as Pipe).kind === "pipe" && !(handle as Pipe).inherited) (handle as Pipe).socket.end(); }),
  };
  const commit = vi.fn(() => { events.push("commit"); });
  const options: WindowsNativeCommandOptions = { file: "git", args: ["status"], cwd: "C:\\fixture", environment: { PATH: "C:\\tools", SystemRoot: "C:\\Windows" },
    stdin: "ignore", resolver: "node", deadline: performance.now() + 10_000, graceMs: 1000, pipeCloseMs: 1000,
    normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close", onReleased: commit };
  const command = spawnWindowsNativeCommand(options, { loadNative: async () => native, loadKernel: async () => jobs,
    createServer: listener => createServer(socket => { accepted.push(socket); listener(socket); }),
    pipeName: () => process.platform === "win32" ? `\\\\.\\pipe\\Daynight-test-${randomUUID()}` : path.relative(process.cwd(), path.join(directory, `${++pipeIndex}.sock`)) });
  return { command, options, jobs, native, root, thread, observation, events, clients, accepted, transportErrors, commit, endOutputs, exit: (value: number) => { exited = true; code = value; } };
};

describe("Windows native command ownership with controlled Win32 calls and real byte pipes", () => {
  it.each([0, 1, 7, 128, 259])("reports actual target exit %i and exact streams before atomically releasing", async code => {
    const f = fixture(), output = Promise.all([collect(f.command.stdout), collect(f.command.stderr)]);
    try {
      await f.command.start(); f.exit(code); f.endOutputs(); await f.command.closed;
      expect(f.command.result).toEqual({ kind: "exit", code, signal: null, failure: null });
      expect(await output).toEqual([Buffer.from([0, 1, 255]), Buffer.from("target stderr")]);
      let yielded = false; queueMicrotask(() => { yielded = true; }); const pending = f.command.release();
      expect(f.commit).toHaveBeenCalledOnce(); expect(yielded).toBe(false); await pending;
      expect(f.events).toEqual(["create", "resume", "thread-close", "root-close", "OFF", "commit", "job-close"]);
      expect(f.jobs.open).not.toHaveBeenCalled(); expect(f.jobs.assignHandle).not.toHaveBeenCalled();
      expect(f.native.duplicateProcess).toHaveBeenCalledWith(f.root); expect(f.jobs.terminate).not.toHaveBeenCalled();
      for (const [handle] of vi.mocked(f.jobs.identity).mock.calls) expect(handle).toBe(f.observation);
      await expect(f.command.stop()).rejects.toThrow("already released");
    } finally { if (f.commit.mock.calls.length === 0) await f.command.stop(); }
  });

  it("keeps root exit separate from actual inherited-pipe EOF and preserves a backpressured tail", async () => {
    const f = fixture(), tail = Buffer.alloc(256 * 1024, 0x7f); f.command.stderr.resume();
    try {
      await f.command.start(); f.exit(0); f.endOutputs(tail, Buffer.alloc(0));
      let closed = false; void f.command.closed.then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 25)); expect(closed).toBe(false); expect(f.command.result).toBeUndefined();
      expect(await collect(f.command.stdout)).toEqual(tail); await f.command.closed; await f.command.release();
    } finally { if (f.commit.mock.calls.length === 0) await f.command.stop(); }
  });

  it("joins forced termination without inventing a target receipt", async () => {
    const f = fixture(); f.command.stdout.resume(); f.command.stderr.resume(); await f.command.start();
    await f.command.stop(); await f.command.closed;
    expect(f.command.result).toBeUndefined(); expect(f.jobs.sealAdmissions).toHaveBeenCalledOnce(); expect(f.jobs.terminate).toHaveBeenCalledOnce();
    expect(f.jobs.close).toHaveBeenCalledOnce(); expect(f.native.close).toHaveBeenCalledWith(f.root); expect(f.commit).not.toHaveBeenCalled();
  });

  it("drains a failed public output to actual socket EOF while retaining the original capture error", async () => {
    const f = fixture(), error = new Error("public capture failed"); f.command.stderr.resume();
    await f.command.start(); f.command.stdout.destroy(error);
    await expect(f.command.closed).rejects.toBe(error);
    await expect(f.command.stop()).resolves.toBeUndefined();
    await Promise.all(f.clients.map(client => client.socket.closed ? undefined : once(client.socket, "close")));
    expect(f.clients.every(client => client.socket.closed)).toBe(true);
    expect(f.jobs.terminate).toHaveBeenCalledOnce(); expect(f.command.result).toBeUndefined(); expect(f.commit).not.toHaveBeenCalled();
    await expect(f.command.release()).rejects.toBeInstanceOf(WindowsCommandCleanupError);
  });

  it("joins actual pipe EOF during STOP when the public output is deliberately backpressured", async () => {
    const f = fixture(); f.command.stderr.resume(); let primary: unknown;
    try {
      await f.command.start(); f.endOutputs(Buffer.alloc(256 * 1024, 0xab), Buffer.alloc(0));
      await expect.poll(() => f.command.stdout.readableLength >= f.command.stdout.readableHighWaterMark, { timeout: 1000, interval: 10 }).toBe(true);
      f.jobs.terminate = () => { f.exit(1); };
      await f.command.stop();
      expect(f.command.stdout.readableEnded).toBe(true); expect(f.command.stderr.readableEnded).toBe(true);
      expect(f.command.result).toBeUndefined(); expect(f.commit).not.toHaveBeenCalled(); expect(f.accepted.every(socket => socket.readableEnded)).toBe(true);
    } catch (error) { primary = error; throw error; }
    finally {
      f.command.stdout.resume(); f.command.stderr.resume();
      const cleanup = await f.command.stop().then(() => undefined, error => error);
      for (const client of f.clients) client.socket.destroy();
      if (cleanup !== undefined && cleanup !== primary) throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], "Backpressure fixture cleanup failed.");
    }
  });

  it("retains an accepted socket read error during STOP and refuses close without actual EOF", async () => {
    const f = fixture(), error = new Error("actual accepted socket read failed"); f.command.stdout.resume(); f.command.stderr.resume();
    await f.command.start();
    f.jobs.terminate = () => { f.exit(1); f.clients[1]!.socket.end(); f.accepted[0]!.destroy(error); };
    const failure = await f.command.stop().then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(WindowsCommandCleanupError);
    expect((failure as WindowsCommandCleanupError).errors.filter(cause => cause === error)).toEqual([error]);
    expect((failure as WindowsCommandCleanupError).errors.some(cause => cause instanceof Error && cause.message.includes("without a natural EOF"))).toBe(true);
    expect(f.accepted[0]!.readableEnded).toBe(false); expect(f.accepted[0]!.closed).toBe(true);
    expect(f.command.result).toBeUndefined(); expect(f.commit).not.toHaveBeenCalled();
    expect(f.native.close).toHaveBeenCalledWith(f.root); expect(f.jobs.close).toHaveBeenCalledOnce();
    await expect(f.command.closed).rejects.toBeInstanceOf(WindowsCommandCleanupError);
    for (const client of f.clients) client.socket.destroy();
  });

  it("does not create or resume after cancellation before startup", async () => {
    const f = fixture(); f.command.stdout.resume(); f.command.stderr.resume(); await f.command.stop();
    await expect(f.command.start()).rejects.toThrow("admission is no longer available");
    expect(f.native.createSuspended).not.toHaveBeenCalled(); expect(f.native.resume).not.toHaveBeenCalled();
  });

  it("finalizes invalid release before startup without creating a target", async () => {
    const f = fixture(); f.command.stdout.resume(); f.command.stderr.resume();
    await expect(f.command.release()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.stringContaining("natural completion") })] });
    await expect(f.command.start()).rejects.toThrow("admission is no longer available");
    expect(f.native.createSuspended).not.toHaveBeenCalled(); expect(f.native.resume).not.toHaveBeenCalled();
  });

  it("reports a genuine executable-resolution failure without creating a Job or target", async () => {
    const f = fixture(); f.native.fileExists = () => false; f.command.stdout.resume(); f.command.stderr.resume();
    await f.command.start(); await f.command.closed;
    expect(f.command.result).toMatchObject({ kind: "not-started", error: { code: "ENOENT", syscall: "spawn git", path: "git", spawnargs: ["status"], win32Code: 2 } });
    expect(f.jobs.createAnonymousJob).not.toHaveBeenCalled(); expect(f.native.createSuspended).not.toHaveBeenCalled();
    await f.command.release(); expect(f.commit).toHaveBeenCalledOnce();
  });

  it("keeps a successfully created original target owned when parent stdio cleanup failed before resume", async () => {
    const f = fixture(), created = f.native.createSuspended, failure = new Error("parent writer close failed");
    f.native.createSuspended = input => ({ ...created(input), cleanupErrors: [failure] });
    f.command.stdout.resume(); f.command.stderr.resume();
    await expect(f.command.start()).rejects.toMatchObject({ errors: [failure] });
    await expect(f.command.stop()).rejects.toMatchObject({ errors: [failure] });
    expect(f.native.resume).not.toHaveBeenCalled(); expect(f.native.duplicateProcess).toHaveBeenCalledWith(f.root);
    expect(f.jobs.open).not.toHaveBeenCalled(); expect(f.native.close).toHaveBeenCalledWith(f.root); expect(f.native.close).toHaveBeenCalledWith(f.thread);
    expect(f.command.result).toBeUndefined();
  });

  it.each(["duplicate", "adopt"])("retains creation finalization and %s errors with the original process still owned", async boundary => {
    const f = fixture(), create = f.native.createSuspended, creation = new Error("partial creation failed"), cleanup = new Error("parent writer finalization failed"), observation = new Error("original observation failed");
    f.native.createSuspended = input => ({ ...create(input), failure: creation, cleanupErrors: [cleanup] });
    f.jobs.inspect = () => [];
    if (boundary === "duplicate") f.native.duplicateProcess = () => { throw observation; };
    else {
      const identity = f.jobs.identity; let calls = 0;
      f.jobs.identity = handle => { if (++calls === 2) throw observation; return identity(handle); };
    }
    f.command.stdout.resume(); f.command.stderr.resume();
    const startup = await f.command.start().then(() => undefined, error => error);
    const stopped = await f.command.stop().then(() => undefined, error => error);
    for (const failure of [startup, stopped]) {
      expect(failure).toBeInstanceOf(WindowsCommandCleanupError);
      const errors = (failure as WindowsCommandCleanupError).errors;
      expect(errors).toHaveLength(3); expect(errors[0]).toBe(creation); expect(errors[1]).toBe(cleanup); expect(errors[2]).toBe(observation);
    }
    expect(f.native.resume).not.toHaveBeenCalled(); expect(f.command.result).toBeUndefined(); expect(f.commit).not.toHaveBeenCalled();
    for (const original of [f.root, f.thread]) expect(vi.mocked(f.native.close).mock.calls.filter(([handle]) => handle === original)).toHaveLength(1);
    expect(f.jobs.open).not.toHaveBeenCalled(); expect(f.jobs.close).toHaveBeenCalledOnce();
  });

  it("keeps a native create failure and its raw cause distinct from process exit", async () => {
    const f = fixture(), failure = new WindowsNativeProcessError("create-process", 193);
    f.native.createSuspended = input => { for (const handle of [input.stdin, input.stdout, input.stderr]) f.native.close(handle); return { created: null, failure, cleanupErrors: [] }; };
    f.command.stdout.resume(); f.command.stderr.resume();
    await f.command.start(); await f.command.closed;
    expect(f.command.result).toMatchObject({ kind: "not-started", error: { code: "EFTYPE", win32Code: 193, cause: failure } });
    expect(f.command.result?.kind === "not-started" && f.command.result.error.cause).toBe(failure);
    await f.command.release(); expect(f.native.resume).not.toHaveBeenCalled(); expect(f.jobs.close).toHaveBeenCalledOnce();
  });

  it("preserves a non-spawn permission refusal without treating it as a target status", async () => {
    const f = fixture(), failure = Object.assign(new Error("denied"), { code: "ERR_ACCESS_DENIED", permission: "ChildProcess" });
    f.native.createSuspended = input => { for (const handle of [input.stdin, input.stdout, input.stderr]) f.native.close(handle); return { created: null, failure, cleanupErrors: [] }; };
    f.command.stdout.resume(); f.command.stderr.resume();
    await expect(f.command.start()).rejects.toBe(failure); await expect(f.command.closed).rejects.toBe(failure); await f.command.stop();
    expect(f.command.result).toBeUndefined(); expect(f.native.resume).not.toHaveBeenCalled(); expect(f.jobs.open).not.toHaveBeenCalled();
  });

  it("rejects a pipe server-owner mismatch before creating target code", async () => {
    const f = fixture(); f.native.serverPid = () => process.pid + 1; f.command.stdout.resume(); f.command.stderr.resume();
    await expect(f.command.start()).rejects.toThrow("server is not owned"); await f.command.stop();
    expect(f.native.createSuspended).not.toHaveBeenCalled(); expect(f.native.resume).not.toHaveBeenCalled();
  });

  it("rejects the wrong private pairing frame before creating target code", async () => {
    const f = fixture(), write = f.native.write;
    f.native.write = (handle, bytes) => { const changed = Buffer.from(bytes); changed[0] = changed[0]! ^ 1; write(handle, changed); };
    f.command.stdout.resume(); f.command.stderr.resume();
    await expect(f.command.start()).rejects.toThrow("pairing frame is invalid"); await f.command.stop();
    expect(f.native.createSuspended).not.toHaveBeenCalled();
  });

  it("cancels a pending pipe handshake without giving target code admission", async () => {
    const f = fixture(); let entered!: () => void;
    const handshaking = new Promise<void>(resolve => { entered = resolve; });
    f.native.write = () => { entered(); };
    f.command.stdout.resume(); f.command.stderr.resume(); const starting = f.command.start(); await handshaking;
    const stopping = f.command.stop(); await expect(starting).rejects.toThrow("startup was stopped"); await stopping;
    expect(f.native.createSuspended).not.toHaveBeenCalled(); expect(f.native.resume).not.toHaveBeenCalled();
  });

  it("holds a late-created target suspended when its original deadline expired", async () => {
    const f = fixture(), duplicate = f.native.duplicateProcess;
    f.native.duplicateProcess = original => { f.options.deadline = performance.now() - 1; return duplicate(original); };
    f.command.stdout.resume(); f.command.stderr.resume();
    await expect(f.command.start()).rejects.toThrow("admission is no longer available"); await f.command.stop();
    expect(f.native.resume).not.toHaveBeenCalled(); expect(f.jobs.terminate).toHaveBeenCalledOnce(); expect(f.command.result).toBeUndefined();
  });

  it("retains failed OFF restoration and native termination errors through finite finalization", async () => {
    const f = fixture(), clear = new Error("clear failed"), restore = new Error("restore failed"), terminate = new Error("native terminate failed");
    const output = Promise.all([collect(f.command.stdout), collect(f.command.stderr)]);
    await f.command.start(); f.exit(0); f.endOutputs(); await f.command.closed; await output;
    f.jobs.clearKillOnClose = () => { throw clear; }; f.jobs.restoreKillOnClose = () => { throw restore; }; f.jobs.terminate = () => { throw terminate; };
    const pending = f.command.release(); expect(f.command.release()).toBe(pending);
    await expect(pending).rejects.toMatchObject({ errors: [clear, restore, terminate] });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.jobs.close).toHaveBeenCalledOnce();
  });

  it("keeps OFF committed after final Job close failure without rearming background work", async () => {
    const f = fixture(), failed = new Error("close failed"); f.command.stdout.resume(); f.command.stderr.resume();
    await f.command.start(); f.exit(0); f.endOutputs(); await f.command.closed;
    f.jobs.close = () => { throw failed; };
    await expect(f.command.release()).rejects.toMatchObject({ errors: [failed] });
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.jobs.restoreKillOnClose).not.toHaveBeenCalled(); expect(f.jobs.terminate).not.toHaveBeenCalled();
  });

  it("restores serialized target error fields with their remote provenance", () => {
    const error = restoreWindowsSpawnError({ name: "Error", message: "spawn git ENOENT", code: "ENOENT", errno: -4058, syscall: "spawn git", path: "git", spawnargs: ["status"] });
    expect(error).toMatchObject({ code: "ENOENT", errno: -4058, syscall: "spawn git", path: "git", spawnargs: ["status"], origin: "windows-target" });
    expect(new WindowsCommandCleanupError([error]).errors[0]).toBe(error);
  });
});
