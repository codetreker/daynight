import { stopWindowsBootstrapProcess } from "../../../src/commands/controller/windows-process-proof.js";
import type { ProcessProof } from "../../../src/commands/controller/process-proof.js";

export const withWindowsFixtureExit = async (proof: ProcessProof, action: () => Promise<void>): Promise<void> => {
  const acquire = async () => {
    const koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
    const open = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
    const times = kernel.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
    const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
    const close = kernel.func("int __stdcall CloseHandle(void *handle)");
    const lastError = kernel.func("uint32_t __stdcall GetLastError()");
    const failure = (operation: string) => new Error(`${operation} failed (Win32 ${lastError()}).`);
    const handle: unknown = open(0x101000, 0, proof.pid);
    if (handle === null) {
      if (lastError() !== 87) throw failure("OpenProcess");
      return null;
    }
    return { handle, times, wait, close, failure };
  };
  let retained: Awaited<ReturnType<typeof acquire>>;
  try { retained = await acquire(); } catch (error) {
    try { await action(); } catch (actionError) { throw new AggregateError([error, actionError], "Native fixture handle acquisition and action failed."); }
    throw error;
  }
  if (retained === null) { await action(); return; }
  const { handle, times, wait, close, failure } = retained;
  const failures: unknown[] = [];
  let matches = false;
  try {
    const creation = Buffer.alloc(8);
    if (times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) throw failure("GetProcessTimes");
    const ticks = creation.readBigUInt64LE() / 10n * 10n - 116444736000000000n;
    const birth = `${new Date(Number(ticks / 10000000n) * 1000).toISOString().slice(0, 19)}.${(ticks % 10000000n).toString().padStart(7, "0")}Z`;
    if (birth !== proof.startedAt) throw new Error("Native fixture identity was replaced.");
    matches = true;
  } catch (error) { failures.push(error); }
  try { await action(); } catch (error) { failures.push(error); }
  if (matches) {
    const deadline = Date.now() + 1000;
    try { await stopWindowsBootstrapProcess(proof, deadline); } catch (error) { failures.push(error); }
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Native fixture handle wait exceeded its deadline.");
      const status = wait(handle, remaining);
      if (status === 258) throw new Error("Native fixture handle wait exceeded its deadline.");
      if (status !== 0) throw failure("WaitForSingleObject");
      if (Date.now() >= deadline) throw new Error("Native fixture handle wait exceeded its deadline.");
    } catch (error) { failures.push(error); }
  }
  try { if (close(handle) === 0) throw failure("CloseHandle"); } catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, "Native fixture action and original-handle cleanup failed.");
  if (failures.length === 1) throw failures[0];
};
