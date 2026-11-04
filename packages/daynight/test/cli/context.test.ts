import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { writeOutputBytes } from "../../src/cli/byte-output.js";

const expectReleased = (output: Writable, signal: AbortSignal): void => {
  expect(output.listenerCount("error")).toBe(0);
  expect(output.listenerCount("close")).toBe(0);
  expect(signal.aborted).toBe(false);
};

describe("binary stdout", () => {
  it("preserves every byte and waits for backpressure to flush", async () => {
    let complete: (error?: Error | null) => void = () => {};
    const chunks: Uint8Array[] = [];
    const output = new Writable({ highWaterMark: 1, write: (chunk: Buffer, _encoding, callback) => { chunks.push(chunk); complete = callback; } });
    const signal = new AbortController().signal;
    let flushed = false;
    const pending = writeOutputBytes(output, new Uint8Array([255, 0, 128]), signal).then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    complete();
    await pending;
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([255, 0, 128]));
    expectReleased(output, signal);
    output.destroy();
  });

  it("reports EPIPE through the awaited write and releases listeners", async () => {
    const failure = Object.assign(new Error("Broken pipe."), { code: "EPIPE" });
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback(failure) });
    const signal = new AbortController().signal;
    await expect(writeOutputBytes(output, new Uint8Array([1]), signal)).rejects.toBe(failure);
    expectReleased(output, signal);
  });

  it("destroys a blocked output handle when cancelled", async () => {
    const destroyed = vi.fn<(error: Error | null, callback: (error?: Error | null) => void) => void>((_error, callback) => callback());
    const output = new Writable({ write: () => {}, destroy: destroyed });
    const cancellation = new AbortController();
    const pending = writeOutputBytes(output, new Uint8Array([1]), cancellation.signal);
    const reason = new Error("Request cancelled.");
    cancellation.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(output.destroyed).toBe(true);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("rejects output closed during a pending write", async () => {
    const output = new Writable({ write: () => {} });
    const pending = writeOutputBytes(output, new Uint8Array([1]), new AbortController().signal);
    output.destroy();
    await expect(pending).rejects.toThrow("closed before");
  });

  it("does not dispatch an already cancelled write", async () => {
    const write = vi.fn();
    const output = new Writable({ write });
    const cancellation = new AbortController();
    const failure = new Error("Cancelled before output.");
    cancellation.abort(failure);
    await expect(writeOutputBytes(output, new Uint8Array([1]), cancellation.signal)).rejects.toBe(failure);
    expect(write).not.toHaveBeenCalled();
    output.destroy();
  });

  it("rejects writes after the output was closed", async () => {
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    output.destroy();
    await expect(writeOutputBytes(output, new Uint8Array([1]), new AbortController().signal)).rejects.toThrow("closed");
  });

  it("releases a real blocked stdout pipe on cancellation", async () => {
    const module = new URL("../../dist/cli/context.js", import.meta.url).href;
    const script = `
      import {createCliContext} from ${JSON.stringify(module)};
      const context = createCliContext('test', '.');
      const controller = new AbortController();
      try {
        await context.stdoutBytes(new Uint8Array([1]), controller.signal);
        setTimeout(() => controller.abort(new Error('Output cancelled.')), 100);
        for (let index = 0; index < 128; index++) await context.stdoutBytes(new Uint8Array(65_536), controller.signal);
      } catch (error) {
        context.stderr(error.message);
        process.exitCode = 1;
      } finally { await context.closeStdoutBytes(); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); child.stdout.destroy(); resolve({ code, signal }); });
    });
    expect(result).toEqual({ code: 1, signal: null });
    expect(Buffer.concat(errors).toString()).toBe("Output cancelled.");
  }, 10_000);

  it("packages the output helper and flushes exact binary bytes before normal shutdown", async () => {
    const module = new URL("../../dist/cli/context.js", import.meta.url).href;
    const script = `
      import {createCliContext} from ${JSON.stringify(module)};
      const context = createCliContext('test', '.');
      const bytes = Uint8Array.from({length: 150_000}, (_, index) => index % 256);
      await context.stdoutBytes(bytes, new AbortController().signal);
      await context.stdoutBytes(new Uint8Array(), new AbortController().signal);
      await context.closeStdoutBytes();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    expect(result).toEqual({ code: 0, signal: null });
    expect(Buffer.concat(output).equals(Uint8Array.from({ length: 150_000 }, (_, index) => index % 256))).toBe(true);
    expect(Buffer.concat(errors).toString()).toBe("");
  }, 10_000);

  it("returns a real broken pipe error and reaps its output helper", async () => {
    const module = new URL("../../dist/cli/context.js", import.meta.url).href;
    const script = `
      import {createCliContext} from ${JSON.stringify(module)};
      const context = createCliContext('test', '.');
      try { await context.stdoutBytes(new Uint8Array(65_536), new AbortController().signal); }
      catch (error) { context.stderr(error.code); process.exitCode = 1; }
      finally { await context.closeStdoutBytes(); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const errors: Buffer[] = [];
    child.stdout.destroy();
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    expect(result).toEqual({ code: 1, signal: null });
    expect(Buffer.concat(errors).toString()).toBe("EPIPE");
  }, 10_000);
});
