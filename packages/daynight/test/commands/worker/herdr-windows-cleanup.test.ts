import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { createMappingProcessLifecycle } from "../../../src/commands/worker/herdr/tool-launch-lifecycle.js";
import { inspectMappingProcessProof } from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import type { HerdrToolLaunchManifest } from "../../../src/commands/worker/herdr/tool-launch-protocol.js";
import * as metadata from "../../../src/commands/worker/herdr/windows-process-metadata.js";
import { recordedHerdrTool } from "./herdr-tool-snapshot.fixtures.js";

const native = vi.hoisted(() => ({ open: vi.fn(), times: vi.fn(), query: vi.fn(), close: vi.fn(), terminate: vi.fn(), wait: vi.fn(), exitCode: vi.fn(), error: 5 }));
vi.mock("koffi", () => ({ sizeof: () => 8, address: () => 0x100000n, load: () => ({ func: (declaration: string) => {
  if (declaration.includes("OpenProcess")) return native.open;
  if (declaration.includes("GetProcessTimes")) return native.times;
  if (declaration.includes("NtQueryInformationProcess")) return native.query;
  if (declaration.includes("CloseHandle")) return native.close;
  if (declaration.includes("TerminateProcess")) return native.terminate;
  if (declaration.includes("WaitForSingleObject")) return native.wait;
  if (declaration.includes("GetExitCodeProcess")) return native.exitCode;
  if (declaration.includes("GetLastError")) return () => native.error;
  throw new Error(`Unexpected native declaration: ${declaration}`);
} }) }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [], operations: Operation[] = [];
const handle = {}, command = "powershell.exe -NoProfile -File original.ps1", fileTime = 134067744001234560n;
const proof = { pid: 4101, parentPid: 4000, processGroupId: null, startedAt: "2025-11-05T00:00:00.1234560Z", commandHash: createHash("sha256").update(command).digest("hex") };
let signaled: boolean;
const operation = () => { const value = createOperation({ limits: { totalMs: 2000 } }); operations.push(value); return value; };
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-windows-cleanup-tests");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "mapping-")); roots.push(directory);
  const manifest: HerdrToolLaunchManifest = { schemaVersion: 1, nonce: randomUUID(), owner: { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() }, launch: recordedHerdrTool("codex"), nativePath: null, nodeExecutable: process.execPath, childEntry: path.join(directory, "child.js"), platform: "win32" };
  await writeFile(path.join(directory, "processes.json"), JSON.stringify({ nonce: manifest.nonce, proofs: [proof] }), { mode: 0o600 });
  return { directory, lifecycle: createMappingProcessLifecycle(path.join(directory, "manifest.json"), manifest, process.env) };
};
beforeEach(() => {
  vi.resetAllMocks(); native.error = 5; signaled = false;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  vi.spyOn(metadata, "captureWindowsProcessInventory").mockResolvedValue([]);
  native.open.mockReturnValue(handle); native.close.mockReturnValue(1); native.terminate.mockReturnValue(1);
  native.times.mockImplementation((observed, creation: Buffer) => { expect(observed).toBe(handle); creation.writeBigUInt64LE(fileTime); return 1; });
  native.wait.mockImplementation((observed, timeout: number) => { expect(observed).toBe(handle); if (timeout > 0) signaled = true; return signaled ? 0 : 258; });
  native.exitCode.mockImplementation((_observed, code: Buffer) => { code.writeUInt32LE(0); return 1; });
  native.query.mockImplementation((_observed, kind: number, data: Buffer, _size: number, returned: Buffer) => {
    if (kind === 0) { data.writeBigUInt64LE(BigInt(proof.pid), 32); data.writeBigUInt64LE(BigInt(proof.parentPid), 40); returned.writeUInt32LE(data.length); }
    else if (kind === 60) { const text = Buffer.from(command, "utf16le"); data.writeUInt16LE(text.length); data.writeUInt16LE(text.length + 2, 2); data.writeBigUInt64LE(0x100010n, 8); text.copy(data, 16); returned.writeUInt32LE(16 + text.length + 2); }
    else throw new Error(`Unexpected information class: ${kind}`);
    return 0;
  });
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor); vi.restoreAllMocks();
  operations.splice(0).forEach(value => value.dispose());
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Herdr Windows original process cleanup", () => {
  it.each(["exit-code", "terminating-query"])("waits for the original shell handle after workspace removal (%s)", async kind => {
    const f = await fixture(), kill = vi.spyOn(process, "kill");
    if (kind === "terminating-query") {
      native.exitCode.mockImplementation((_observed, code: Buffer) => { code.writeUInt32LE(259); return 1; });
      native.query.mockReturnValue(0xc000010a | 0);
    }
    await expect(f.lifecycle.captureProcesses([proof.pid], operation(), true)).resolves.toEqual([proof.pid]);
    expect(await f.lifecycle.confirmStopped(operation())).toBe(false);
    await expect(inspectMappingProcessProof(proof)).rejects.toThrow("exiting");
    await f.lifecycle.stopProcesses(operation());
    const waits = native.wait.mock.calls.filter(call => call[1] > 0);
    expect(waits).toHaveLength(1); expect(waits[0]![0]).toBe(handle); expect(waits[0]![1]).toBeLessThanOrEqual(2000);
    expect(native.terminate).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(native.open.mock.calls.length).toBe(native.close.mock.calls.length);
    expect(await f.lifecycle.confirmStopped(operation())).toBe(true);
    await f.lifecycle.retire(operation());
    expect(JSON.parse(await readFile(path.join(f.directory, "retired.json"), "utf8"))).toHaveProperty("nonce");
  });

  it("keeps completion unconfirmed when an exiting shell never signals", async () => {
    const f = await fixture(); native.wait.mockReturnValue(258);
    await expect(f.lifecycle.stopProcesses(operation())).rejects.toThrow("did not finish exiting");
    expect(await f.lifecycle.confirmStopped(operation())).toBe(false);
    await expect(f.lifecycle.retire(operation())).rejects.toThrow("not confirmed stopped");
    await expect(readFile(path.join(f.directory, "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(native.terminate).not.toHaveBeenCalled(); expect(native.open.mock.calls.length).toBe(native.close.mock.calls.length);
  });

  it("terminates a still-running original through its held handle", async () => {
    const f = await fixture(), kill = vi.spyOn(process, "kill");
    native.exitCode.mockImplementation((_observed, code: Buffer) => { code.writeUInt32LE(259); return 1; });
    await f.lifecycle.stopProcesses(operation());
    expect(native.terminate).toHaveBeenCalledExactlyOnceWith(handle, 1); expect(kill).not.toHaveBeenCalled();
    expect(native.wait.mock.calls.some(call => call[0] === handle && call[1] > 0)).toBe(true);
  });

  it.each(["birth", "command", "permission"])("preserves unknown ownership when inventory is empty (%s)", async kind => {
    const f = await fixture();
    if (kind === "birth") native.times.mockImplementation((_observed, creation: Buffer) => { creation.writeBigUInt64LE(fileTime + 10n); return 1; });
    if (kind === "command") {
      native.exitCode.mockImplementation((_observed, code: Buffer) => { code.writeUInt32LE(259); return 1; });
      const query = native.query.getMockImplementation()!;
      native.query.mockImplementation((...args) => { const result = query(...args); if (args[1] === 60) (args[2] as Buffer).writeUInt16LE(88, 16); return result; });
    }
    if (kind === "permission") native.open.mockReturnValue(null);
    await expect(f.lifecycle.stopProcesses(operation())).rejects.toThrow(/identity|birth/);
    await expect(f.lifecycle.confirmStopped(operation())).rejects.toThrow(/identity|birth/);
    expect(native.terminate).not.toHaveBeenCalled(); expect(native.wait.mock.calls.some(call => call[1] > 0)).toBe(false);
  });

  it("does not retire after original handle release fails", async () => {
    const f = await fixture();
    native.close.mockImplementation(() => signaled ? 0 : 1);
    await expect(f.lifecycle.stopProcesses(operation())).rejects.toThrow("close-process-handle");
    await expect(readFile(path.join(f.directory, "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
