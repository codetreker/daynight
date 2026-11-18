import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

export type WindowsBootIdentity = { machineHash: string; bootId: string };

export const readWindowsBootIdentity = async (deadline: number): Promise<WindowsBootIdentity> => {
  if (process.platform !== "win32") throw new Error("Windows reboot evidence is unavailable on this platform.");
  const remaining = () => {
    const left = deadline - Date.now();
    if (!Number.isSafeInteger(left) || left <= 0) throw new Error("Windows boot observation exceeded its deadline.");
    return Math.min(left, 5000);
  };
  remaining();
  const root = process.env.SystemRoot;
  if (root === undefined || !path.win32.isAbsolute(root)) throw new Error("Windows boot observation requires an absolute SystemRoot.");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(path.win32.join(root, "System32", "reg.exe"), ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
      { encoding: "utf8", windowsHide: true, timeout: remaining(), maxBuffer: 4096 },
      (error, stdout) => error === null ? resolve(stdout) : reject(new Error("Windows installation identity could not be observed.", { cause: error })));
  });
  const machine = /\bMachineGuid\s+REG_SZ\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*$/imu.exec(output)?.[1]?.toLowerCase();
  if (machine === undefined || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(machine)) throw new Error("Windows installation identity is invalid.");
  remaining();
  const koffi = await import("koffi");
  const query = koffi.load("ntdll.dll").func("int32_t __stdcall NtQuerySystemInformation(uint32_t kind, void *data, uint32_t size, void *returned)");
  const data = Buffer.alloc(32), returned = Buffer.alloc(4);
  remaining();
  const status = query(90, data, data.length, returned) as number;
  remaining();
  if (status !== 0 || returned.readUInt32LE() !== data.length || data.subarray(0, 16).every(byte => byte === 0)) throw new Error(`Windows boot identity is unavailable (NTSTATUS ${status >>> 0}).`);
  return { machineHash: createHash("sha256").update(machine).digest("hex"), bootId: data.subarray(0, 16).toString("hex") };
};
