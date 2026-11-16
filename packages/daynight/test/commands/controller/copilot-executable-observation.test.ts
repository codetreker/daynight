import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: processMock.spawn }));
import { startCopilotProcess } from "../../../src/commands/controller/providers/copilot-owned-process.js";

afterEach(() => vi.clearAllMocks());

// Real resolution and file verification own the digest. This assembly test
// controls only the process boundary, without executing Copilot or Node flags.
test.skipIf(process.platform !== "win32")("verified native executable identity belongs to the selected process lifetime", async () => {
  const operation = createOperation();
  const launch = await resolveToolLaunch({ tool: "copilot", context: "herdr", choice: { kind: "path", path: process.execPath }, cwd: process.cwd(), environment: process.env, workerNode: process.execPath }, operation).finally(() => operation.dispose());
  const digest = launch.artifacts.find(item => item.realPath === launch.executablePath)!.sha256;
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { child.emit("exit", 0); child.emit("close", 0); return true; }) });
  processMock.spawn.mockImplementation(() => { queueMicrotask(() => { child.emit("spawn"); child.stdout.write("Listening on port 12345\n"); }); return child; });
  const runtime = startCopilotProcess({ cwd: process.cwd(), toolLaunch: launch, onSpawn() {} }, () => {});
  expect(runtime.nativeExecutableSha256).toBeNull();
  try {
    await runtime.ready;
    expect(processMock.spawn).toHaveBeenCalledWith(launch.executablePath, ["--headless", "--no-auto-update"], expect.any(Object));
    expect(runtime.nativeExecutableSha256).toBe(digest);
    child.emit("exit", 1);
    expect(runtime.nativeExecutableSha256).toBeNull();
  } finally { await runtime.close(); }
  expect(runtime.nativeExecutableSha256).toBeNull();
});
