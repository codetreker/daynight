import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import { writeOutputBytes } from "../../../src/cli/byte-output.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { renderSessionOperation } from "../../../src/commands/task/session/output.js";
import { formatError } from "../../../src/platform/diagnostics.js";
import { actorId, origin, target } from "../task/session/fixtures.js";
let root: string;
beforeAll(async () => { const tmp = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url)); await mkdir(tmp, { recursive: true }); root = await mkdtemp(path.join(tmp, "session-runtime-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const result = () => renderSessionOperation({ ...target, schemaVersion: 1, origin, actorId, state: "unknown", operation: null, currentBinding: null, waitExpired: false, problem: null }, true, 130);
const fixture = async () => {
  const home = await mkdtemp(path.join(root, "home-")); await mkdir(path.join(home, ".daynight")); await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: ${origin}\nserverToken: test-token\n`);
  const signals = new EventEmitter();
  const context: CliContext = { version: "0", packageDirectory: "unused", homeDirectory: () => home, workingDirectory: () => home, stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}), closeStdoutBytes: vi.fn(async () => {}) };
  return { context, signals };
};
it("prints a known original operation with a fresh budget after user cancellation", async () => {
  const f = await fixture();
  f.context.stdoutBytes = vi.fn(async (bytes, signal) => { expect(signal.aborted).toBe(false); expect(Buffer.from(bytes).toString()).toContain(target.operationId); });
  await expect(runServerCommand(f.context, async session => { f.signals.emit("SIGINT"); expect(session.operation.signal.aborted).toBe(true); return result(); }, { signalEmitter: f.signals })).rejects.toMatchObject({ exitCode: 130 });
  expect(f.context.stdoutBytes).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.signals.listenerCount("SIGINT")).toBe(0);
});
it("keeps known-operation diagnostics and exit 1 for a real failing stdout stream", async () => {
  const f = await fixture(), sink = new Writable({ write: (_chunk, _encoding, callback) => callback(new Error("untrusted-secret")) });
  f.context.stdoutBytes = (bytes, signal) => writeOutputBytes(sink, bytes, signal);
  const error = await runServerCommand(f.context, async () => result(), { signalEmitter: f.signals }).catch((error: unknown) => error);
  expect(error).toMatchObject({ exitCode: 1 }); expect(formatError(error)).toContain(target.operationId); expect(formatError(error)).toContain("output failed"); expect(formatError(error)).not.toContain("untrusted-secret");
});
it("treats cleanup failure as exit 1 after successful known-operation output", async () => {
  const f = await fixture(); f.context.closeStdoutBytes = async () => { throw new Error("untrusted-secret"); };
  const error = await runServerCommand(f.context, async () => result(), { signalEmitter: f.signals }).catch((error: unknown) => error);
  expect(error).toMatchObject({ exitCode: 1 }); expect(formatError(error)).toContain(target.operationId); expect(formatError(error)).toContain("cleanup failed"); expect(formatError(error)).not.toContain("untrusted-secret");
});
it("limits a blocked receipt output to its separate five second budget", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    f.context.stdoutBytes = async (_bytes, signal) => { entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
    const running = runServerCommand(f.context, async () => result(), { signalEmitter: f.signals }).catch((error: unknown) => error);
    await ready; await vi.advanceTimersByTimeAsync(5_001); expect(await running).toMatchObject({ exitCode: 1 });
  } finally { vi.useRealTimers(); }
});
