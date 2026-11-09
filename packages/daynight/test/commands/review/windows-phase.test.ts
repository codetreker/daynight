import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnWindowsReviewPhase } from "../../../src/commands/review/windows-phase.js";
import { WindowsReviewJobSetupError } from "../../../src/commands/review/windows-job-scope.js";
import type { WindowsReviewJobScope } from "../../../src/commands/review/windows-job-scope.js";

let directory: string;
beforeAll(async () => { const root = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, "review-phase-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const scope = (): WindowsReviewJobScope => ({ assignGuardian: vi.fn(), stop: vi.fn(async () => {}) });
const options = (args: string[]) => ({ file: process.execPath, args, cwd: directory, environment: process.env, deadline: performance.now() + 10_000, graceMs: 1_000 });
const text = async (stream: NodeJS.ReadableStream): Promise<string> => { let value = ""; for await (const chunk of stream) value += String(chunk); return value; };

describe("review guardian protocol with controlled Job admission", () => {
  it("streams prompt and both outputs without the capability probe's output limit", async () => {
    const lease = scope();
    const phase = spawnWindowsReviewPhase(options(["-e", "process.stdin.pipe(process.stdout);process.stderr.write('independent');process.exitCode=7"]), { createScope: async () => lease });
    const closed = once(phase.child, "close");
    const outputs = Promise.all([text(phase.child.stdout!), text(phase.child.stderr!)]);
    const prompt = "streamed prompt\n".repeat(32_768);
    const input = pipeline(Readable.from([prompt]), phase.child.stdin!);
    try {
      await phase.start(); await closed; await input;
      expect(await outputs).toEqual([prompt, "independent"]);
      expect(phase.result).toEqual({ code: 7, signal: null, failure: null });
      expect(lease.assignGuardian).toHaveBeenCalledExactlyOnceWith(phase.child.pid);
    } finally { await phase.stop(); }
    expect(lease.stop).toHaveBeenCalledOnce();
  });

  it("admits the target's Node preload only after scope assignment", async () => {
    const preload = path.join(directory, "preload.cjs"), marker = path.join(directory, "preload-ran");
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'target');`);
    let entered!: () => void, allow!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { allow = resolve; });
    const lease = scope();
    const phase = spawnWindowsReviewPhase({ ...options(["-e", "process.stdin.resume()"]), environment: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}` } },
      { createScope: async () => { entered(); await gate; return lease; } });
    phase.child.stdout!.resume(); phase.child.stderr!.resume(); phase.child.stdin!.end();
    const closed = once(phase.child, "close");
    const starting = phase.start();
    try {
      await waiting;
      expect(existsSync(marker)).toBe(false);
      expect(lease.assignGuardian).not.toHaveBeenCalled();
      allow(); await starting; await closed;
      expect(existsSync(marker)).toBe(true);
    } finally { allow(); await phase.stop(); }
  });

  it.each(["setup", "configuration", "assignment", "cancel", "disconnect"])("does not run target code after %s before admission", async failure => {
    const marker = path.join(directory, `forbidden-${failure}`);
    const lease = scope();
    let entered!: () => void, release!: () => void;
    const initializing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (failure === "assignment") lease.assignGuardian = () => { throw new Error("assignment failed"); };
    const phase = spawnWindowsReviewPhase(options(["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`]),
      { createScope: async () => { if (failure === "setup") throw new Error("setup failed"); if (failure === "configuration") throw new WindowsReviewJobSetupError(lease, new Error("configuration failed")); if (failure === "disconnect") { entered(); await gate; } return lease; } });
    phase.child.stdout!.resume(); phase.child.stderr!.resume(); phase.child.stdin!.end();
    try {
      if (failure === "cancel") await phase.stop();
      const starting = phase.start();
      if (failure === "disconnect") { await initializing; phase.child.disconnect(); release(); }
      await expect(starting).rejects.toThrow();
    } finally { release(); await phase.stop(); }
    expect(existsSync(marker)).toBe(false);
    if (["configuration", "assignment", "disconnect"].includes(failure)) expect(lease.stop).toHaveBeenCalledOnce();
  });

  it("joins partially acquired ownership when cancellation races with Job setup", async () => {
    const marker = path.join(directory, "forbidden-pending-setup"), lease = scope();
    let entered!: () => void, release!: () => void;
    const initializing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const phase = spawnWindowsReviewPhase(options(["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`]),
      { createScope: async () => { entered(); await gate; return lease; } });
    phase.child.stdout!.resume(); phase.child.stderr!.resume(); phase.child.stdin!.end();
    const starting = phase.start();
    try {
      await initializing;
      const stopped = phase.stop(); release();
      await expect(starting).rejects.toThrow("admission is no longer available");
      await stopped; await phase.closed;
      expect(lease.assignGuardian).not.toHaveBeenCalled();
      expect(lease.stop).toHaveBeenCalledOnce();
      expect(existsSync(marker)).toBe(false);
    } finally { release(); await phase.stop(); }
  });

  it("keeps command-not-found separate from the guardian's own exit code", async () => {
    const phase = spawnWindowsReviewPhase({ ...options([]), file: path.join(directory, "missing-command") }, { createScope: async () => scope() });
    phase.child.stdout!.resume(); phase.child.stderr!.resume(); phase.child.stdin!.end();
    const closed = once(phase.child, "close");
    try {
      await phase.start(); await closed;
      expect(phase.result?.failure?.missing).toBe(true);
      expect(phase.result?.failure?.message).toContain("ENOENT");
      expect(phase.result?.code).not.toBe(0);
    } finally { await phase.stop(); }
  });
});
