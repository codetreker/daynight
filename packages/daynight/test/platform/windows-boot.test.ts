import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readWindowsBootIdentity } from "../../src/platform/windows-boot.js";

const f = vi.hoisted(() => ({ exec: vi.fn(), query: vi.fn(), load: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: f.exec }));
vi.mock("koffi", () => ({ load: f.load }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const machine = "12345678-1234-1234-1234-123456789abc";
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, `\r\n    MachineGuid    REG_SZ    ${machine.toUpperCase()}\r\n`));
  f.load.mockReturnValue({ func: () => f.query });
  f.query.mockImplementation((_kind, data: Buffer, _length, returned: Buffer) => { data.fill(3, 0, 16); returned.writeUInt32LE(32); return 0; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform); f.exec.mockReset(); f.query.mockReset(); f.load.mockReset(); });

test("observes the kernel boot GUID and hashes the canonical Windows installation identity", async () => {
  expect(await readWindowsBootIdentity(Date.now() + 10_000)).toEqual({ machineHash: createHash("sha256").update(machine).digest("hex"), bootId: "03".repeat(16) });
  expect(f.exec.mock.calls[0]!.slice(0, 3)).toEqual(["C:\\Windows\\System32\\reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], expect.objectContaining({ windowsHide: true, timeout: expect.any(Number) })]);
  expect(f.query).toHaveBeenCalledWith(90, expect.any(Buffer), 32, expect.any(Buffer));
});

test.each(["platform", "deadline", "root", "registry", "machine", "status", "length", "zero-guid"])("refuses unknown or invalid %s observations without fallback", async kind => {
  if (kind === "platform") Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  if (kind === "root") vi.stubEnv("SystemRoot", "relative");
  if (kind === "registry") f.exec.mockImplementation((_file, _args, _options, callback) => callback(new Error("denied"), ""));
  if (kind === "machine") f.exec.mockImplementation((_file, _args, _options, callback) => callback(null, "MachineGuid REG_SZ invalid"));
  if (["status", "length", "zero-guid"].includes(kind)) f.query.mockImplementation((_kind, data: Buffer, _length, returned: Buffer) => { data.fill(kind === "zero-guid" ? 0 : 3); returned.writeUInt32LE(kind === "length" ? 24 : 32); return kind === "status" ? -1 : 0; });
  await expect(readWindowsBootIdentity(kind === "deadline" ? Date.now() - 1 : Date.now() + 10_000)).rejects.toThrow();
});
