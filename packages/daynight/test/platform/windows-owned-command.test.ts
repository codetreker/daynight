import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WindowsCommandCleanupError, restoreWindowsSpawnError } from "../../src/platform/windows-owned-command.js";
import type { WindowsOwnedCommandOptions } from "../../src/platform/windows-owned-command.js";
import type { WindowsCommandOwnership, WindowsKillPolicy } from "../../src/platform/windows-command-job.js";
import { spawnNodeGuardianCommand, windowsNodeGuardianSource } from "../../src/platform/windows-node-guardian.js";

let directory: string;
beforeAll(async () => { const root = path.resolve(import.meta.dirname, "../../../../.tmp"); await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, "owned-command-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const collect = async (stream: Readable): Promise<Buffer> => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
const lease = () => {
  let policy: WindowsKillPolicy = "ON";
  const owner: WindowsCommandOwnership = {
    get killPolicy() { return policy; }, assignGate: vi.fn(), stopUntil: vi.fn(async () => {}),
    release: vi.fn(onReleased => { policy = "OFF"; onReleased(); }),
    restoreKillOnCloseUntil: vi.fn(() => { policy = "ON"; return []; }),
    requestFailureClose: vi.fn(() => []), closeObservations: vi.fn(() => []),
  };
  return { owner, setPolicy: (value: WindowsKillPolicy) => { policy = value; } };
};
const options = (args: string[], commit: () => void): WindowsOwnedCommandOptions => ({
  file: process.execPath, args, cwd: directory, environment: process.env, stdin: "ignore", resolver: "node",
  deadline: performance.now() + 10_000, graceMs: 1000, pipeCloseMs: 1000,
  normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close", onReleased: commit,
});

describe("Windows owned-command Node gate with controlled ownership", () => {
  it("exits an already disconnected bootstrap before loading a resolver or admitting a target", () => {
    const exited = new Error("bootstrap exited"), events: string[] = [], require = vi.fn();
    const disconnected = {
      connected: false,
      on: vi.fn((name: string) => { events.push(name); }),
      exit: vi.fn(() => { throw exited; }),
    };
    expect(() => runInNewContext(windowsNodeGuardianSource, { process: disconnected, require })).toThrow(exited);
    expect(events).toEqual(["disconnect"]); expect(disconnected.exit).toHaveBeenCalledWith(1);
    expect(require).not.toHaveBeenCalled();
  });

  it.each([0, 1, 7, 128])("forwards target exit %i and exact byte streams, then commits release synchronously", async code => {
    const f = lease(), commit = vi.fn();
    const backend = spawnNodeGuardianCommand(options(["-e", `process.stdout.write(Buffer.from([0,1,255]));process.stderr.write('target stderr');process.exitCode=${code}`], commit), { createScope: async () => f.owner });
    const { command } = backend, output = Promise.all([collect(command.stdout), collect(command.stderr)]);
    try {
      await command.start(); await command.closed;
      expect(command.result).toEqual({ kind: "exit", code, signal: null, failure: null });
      expect(await output).toEqual([Buffer.from([0, 1, 255]), Buffer.from("target stderr")]);
      expect(backend.guardianChild.exitCode).toBe(0);
      let yielded = false; queueMicrotask(() => { yielded = true; });
      const releasing = command.release();
      expect(commit).toHaveBeenCalledOnce(); expect(yielded).toBe(false);
      await releasing;
      expect(f.owner.stopUntil).not.toHaveBeenCalled(); expect(f.owner.assignGate).toHaveBeenCalledWith(backend.guardianChild.pid);
      await expect(command.stop()).rejects.toThrow("already released");
    } finally { if (commit.mock.calls.length === 0) await command.stop(); }
  });

  it("finalizes a release requested before admission instead of leaving a trusted helper running", async () => {
    const marker = path.join(directory, "unadmitted-release-target"), f = lease();
    const createScope = vi.fn(async () => f.owner);
    const backend = spawnNodeGuardianCommand(options(["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], () => {}), { createScope });
    backend.command.stdout.resume(); backend.command.stderr.resume();
    await expect(backend.command.release()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.stringContaining("natural completion") })] });
    await backend.physicalClosed;
    expect(createScope).not.toHaveBeenCalled(); expect(existsSync(marker)).toBe(false);
    await expect(backend.command.start()).rejects.toThrow("admission is no longer available");
  });

  it("keeps target Node preloads outside trusted bootstrap and restores them only after assignment", async () => {
    const marker = path.join(directory, "target-preload-marker"), preload = path.join(directory, "target-preload.cjs");
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'target');`);
    const f = lease(), commit = vi.fn(); let entered!: () => void, allow!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { allow = resolve; });
    f.owner.assignGate = vi.fn(() => { expect(existsSync(marker)).toBe(false); });
    const nodeOptions = process.env.NODE_OPTIONS === undefined ? "" : process.env.NODE_OPTIONS;
    const backend = spawnNodeGuardianCommand({ ...options(["-e", "process.stdout.write('target')"], commit), environment: { ...process.env, NODE_OPTIONS: `${nodeOptions} --require ${JSON.stringify(preload)}`, NODE_DEBUG: "" } },
      { createScope: async () => { entered(); await gate; return f.owner; } });
    backend.command.stdout.resume(); backend.command.stderr.resume();
    const starting = backend.command.start();
    try {
      await waiting; expect(existsSync(marker)).toBe(false); expect(f.owner.assignGate).not.toHaveBeenCalled();
      allow(); await starting; await backend.command.closed;
      expect(await readFile(marker, "utf8")).toBe("target"); await backend.command.release();
    } finally { allow(); if (commit.mock.calls.length === 0) await backend.command.stop(); }
  });

  it("forwards a real pre-spawn ENOENT with remote provenance rather than the helper exit code", async () => {
    const f = lease(), commit = vi.fn();
    const { command } = spawnNodeGuardianCommand({ ...options([], commit), file: path.join(directory, "missing-target") }, { createScope: async () => f.owner });
    command.stdout.resume(); command.stderr.resume();
    try {
      await command.start(); await command.closed;
      expect(command.result?.kind).toBe("not-started");
      if (command.result?.kind !== "not-started") throw new Error("Expected missing-target receipt.");
      const restored = restoreWindowsSpawnError(command.result.error);
      expect(restored).toMatchObject({ code: "ENOENT", origin: "windows-target", path: path.join(directory, "missing-target") });
      await command.release();
    } finally { if (commit.mock.calls.length === 0) await command.stop(); }
  });

  it("joins a real forcibly stopped helper without requiring an unreceived target result", async () => {
    const marker = path.join(directory, "forced-target-pid"), f = lease();
    let target: number | undefined, targetKilled = false;
    const backend = spawnNodeGuardianCommand(options(["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000).unref()`], () => {}), { createScope: async () => f.owner });
    backend.command.stdout.resume(); backend.command.stderr.resume();
    f.owner.stopUntil = vi.fn(async () => {
      const exited = once(backend.guardianChild, "exit");
      backend.guardianChild.kill("SIGKILL"); await exited;
      if (target !== undefined) { process.kill(target, "SIGKILL"); targetKilled = true; }
    });
    try {
      await backend.command.start();
      await expect.poll(() => existsSync(marker), { timeout: 4000, interval: 10 }).toBe(true);
      target = Number(await readFile(marker, "utf8")); expect(process.kill(target, 0)).toBe(true);
      await backend.command.stop(); await backend.command.closed;
      expect(backend.command.result).toBeUndefined(); expect(f.owner.stopUntil).toHaveBeenCalledOnce();
      expect(f.owner.release).not.toHaveBeenCalled();
    } finally {
      if (!targetKilled) {
        if (target === undefined && existsSync(marker)) target = Number(await readFile(marker, "utf8"));
        if (target !== undefined) { try { process.kill(target, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } }
      }
      await backend.command.stop();
    }
  });

  it("owns failed disarm finalization and preserves raw errors without a fresh release attempt", async () => {
    const f = lease(), clear = new Error("clear failed"), restore = new Error("restore failed"), stop = new Error("stop failed"), commit = vi.fn();
    f.owner.release = vi.fn(() => { f.setPolicy("UNKNOWN"); throw clear; });
    f.owner.restoreKillOnCloseUntil = vi.fn(() => [restore]); f.owner.stopUntil = vi.fn(async () => { throw stop; });
    const { command } = spawnNodeGuardianCommand(options(["-e", ""], commit), { createScope: async () => f.owner });
    command.stdout.resume(); command.stderr.resume(); await command.start(); await command.closed;
    const releasing = command.release(); expect(command.release()).toBe(releasing);
    try { await releasing; throw new Error("Expected failed release."); }
    catch (error) { expect(error).toBeInstanceOf(WindowsCommandCleanupError); expect((error as WindowsCommandCleanupError).errors).toEqual([clear, restore, stop]); }
    expect(commit).not.toHaveBeenCalled(); expect(f.owner.release).toHaveBeenCalledOnce();
    expect(f.owner.requestFailureClose).toHaveBeenCalledOnce(); expect(f.owner.closeObservations).toHaveBeenCalledOnce();
  });

  it("does not stop or rearm after OFF committed even when final close reports failure", async () => {
    const f = lease(), failed = new Error("native close failed"), commit = vi.fn();
    f.owner.release = vi.fn(onReleased => { f.setPolicy("OFF"); onReleased(); throw failed; });
    const { command } = spawnNodeGuardianCommand(options(["-e", ""], commit), { createScope: async () => f.owner });
    command.stdout.resume(); command.stderr.resume(); await command.start(); await command.closed;
    await expect(command.release()).rejects.toMatchObject({ errors: [failed] });
    expect(commit).toHaveBeenCalledOnce(); expect(f.owner.restoreKillOnCloseUntil).not.toHaveBeenCalled();
    expect(f.owner.stopUntil).not.toHaveBeenCalled(); expect(f.owner.requestFailureClose).not.toHaveBeenCalled();
    await expect(command.stop()).rejects.toThrow("already released");
  });
});
