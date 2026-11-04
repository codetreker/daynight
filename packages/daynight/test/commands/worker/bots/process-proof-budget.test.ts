import { beforeEach, describe, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
import { captureProcessProof } from "../../../../src/commands/controller/process-proof.js";

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation((_file, _args, _options, callback) => callback(null, process.platform === "win32"
    ? JSON.stringify({ ProcessId: 42, ParentProcessId: 1, Birth: "2026-11-05T00:00:00Z", CommandLine: "fixture" })
    : "42 1 42 Thu Nov 5 00:00:00 2026 fixture\n"));
});
describe("process ownership observation budgets", () => {
  it("retains the shared five-second default", async () => {
    expect((await captureProcessProof(42)).pid).toBe(42);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
  });
  it("passes the caller's explicit finite budget to the OS observation", async () => {
    expect((await captureProcessProof(42, 15_000)).pid).toBe(42);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 15_000 });
  });
  it.each([0, -1, Infinity, 1.5, 2_147_483_648])("rejects invalid budget %s before spawning", async budget => {
    await expect(captureProcessProof(42, budget)).rejects.toThrow(/timeout/);
    expect(execute).not.toHaveBeenCalled();
  });
});
