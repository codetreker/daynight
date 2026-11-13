import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Operation } from "../../../api/operation.js";
import { HerdrCommandDeadlineError } from "./command.js";

export class WindowsProcessMetadataError extends Error {
  constructor(readonly stage: string, readonly code: number) {
    super(`Windows process metadata ${stage} failed (Win32 ${code}).`);
    this.name = "WindowsProcessMetadataError";
  }
}
type Candidate = { pid: number; parentPid: number; group: null };
type Kernel = {
  readonly pointerSize: number;
  open(pid: number): unknown;
  live(handle: unknown): void;
  image(handle: unknown): string;
  birth(handle: unknown): bigint;
  snapshot(): unknown;
  entry(handle: unknown, data: Buffer, first: boolean): boolean;
  close(handle: unknown): void;
};
let kernel: Promise<Kernel> | undefined;
const loadKernel = async (): Promise<Kernel> => {
  const koffi = await import("koffi"), library = koffi.load("kernel32.dll");
  const open = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const image = library.func("int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, void *size)");
  const times = library.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const wait = library.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const snapshot = library.func("void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)");
  const first = library.func("int __stdcall Process32FirstW(void *snapshot, void *entry)");
  const next = library.func("int __stdcall Process32NextW(void *snapshot, void *entry)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const pointerSize = koffi.sizeof("uintptr_t");
  if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported Windows process pointer size.");
  const failure = (stage: string) => new WindowsProcessMetadataError(stage, lastError() as number);
  return {
    pointerSize,
    open: pid => {
      const handle: unknown = open(0x00101000, 0, pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
      if (handle === null) throw failure("OpenProcess");
      return handle;
    },
    live: handle => {
      const result = wait(handle, 0) as number;
      if (result === 0) throw new Error("The original Windows process exited during metadata observation.");
      if (result !== 258) throw failure("WaitForSingleObject"); // WAIT_TIMEOUT
    },
    image: handle => {
      // Size is in UTF-16 code units, excluding the terminating null on return.
      // flags=0 requests a Win32 path, matching the original PS5 readiness path.
      // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew
      const data = Buffer.alloc(32768 * 2), size = Buffer.alloc(4);
      size.writeUInt32LE(data.length / 2);
      if (image(handle, 0, data, size) === 0) throw failure("QueryFullProcessImageNameW");
      const length = size.readUInt32LE(), value = data.toString("utf16le", 0, length * 2);
      if (length === 0 || length >= data.length / 2 || value.includes("\0") || !path.win32.isAbsolute(value) || path.win32.parse(value).root === "\\") throw new Error("The Windows process executable path is incomplete.");
      return value;
    },
    birth: handle => {
      const creation = Buffer.alloc(8);
      if (times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) throw failure("GetProcessTimes");
      return creation.readBigUInt64LE();
    },
    snapshot: () => {
      const handle: unknown = snapshot(2, 0); // TH32CS_SNAPPROCESS
      if (handle === null || koffi.address(handle) === (1n << BigInt(pointerSize * 8)) - 1n) throw failure("CreateToolhelp32Snapshot");
      return handle;
    },
    entry: (handle, data, initial) => {
      const available = (initial ? first : next)(handle, data) as number;
      if (available !== 0) return true;
      const code = lastError() as number;
      if (code !== 18) throw new WindowsProcessMetadataError(initial ? "Process32FirstW" : "Process32NextW", code); // ERROR_NO_MORE_FILES
      return false;
    },
    close: handle => { if (close(handle) === 0) throw failure("CloseHandle"); },
  };
};

const observationCheck = (operation: Operation): (() => void) => {
  // Keep the former command runner's acquisition allowance. No child process
  // or timer is needed; entered native calls are joined before rejecting.
  const deadline = performance.now() + Math.max(1, Math.floor(Math.min(10_000, operation.remainingMs(), operation.limits.requestMs)));
  return () => { operation.check(); if (performance.now() >= deadline) throw new HerdrCommandDeadlineError(); };
};
const releaseAfter = <T>(api: Kernel, handle: unknown, check: () => void, observe: () => T): T => {
  let value: T | undefined, failure: unknown, failed = false;
  try { check(); value = observe(); check(); }
  catch (error) { failed = true; failure = error; }
  try { api.close(handle); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "Windows process metadata acquisition and handle release failed.", { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  check();
  return value!;
};

/** Hold one process object for executable, exact birth and both liveness checks.
 * Native calls are joined; cancellation/deadlines reject late observations and
 * never abandon an acquired handle or publish a partial identity.
 */
export const readWindowsProcessMetadata = async (pid: number, operation: Operation): Promise<{ executable: string; startToken: string }> => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error("Windows metadata requires a positive supported process identifier.");
  const check = observationCheck(operation);
  check();
  const api = await (kernel ??= loadKernel());
  check();
  const handle = api.open(pid);
  return releaseAfter(api, handle, check, () => {
    api.live(handle); check();
    const executable = api.image(handle); check();
    const fileTime = api.birth(handle); check();
    // Both epochs count 100ns intervals. Keep all digits from GetProcessTimes;
    // the controller's persisted CIM-compatible timestamp truncates precision.
    // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
    const ticks = fileTime + 504911232000000000n;
    if (fileTime <= 0n || ticks > 3155378975999999999n) throw new Error("Invalid Windows process creation time.");
    api.live(handle); check();
    return { executable, startToken: ticks.toString() };
  });
};

/** A complete snapshot discovers candidates only; parent and birth ownership
 * still require the caller's original process proofs and Job boundary.
 */
export const captureWindowsProcessInventory = async (operation: Operation): Promise<Candidate[]> => {
  const check = observationCheck(operation);
  check();
  const api = await (kernel ??= loadKernel());
  check();
  const handle = api.snapshot();
  return releaseAfter(api, handle, check, () => {
    // PROCESSENTRY32W aligns its ULONG_PTR before th32ParentProcessID.
    const data = Buffer.alloc(api.pointerSize === 8 ? 568 : 556), ids = new Set<number>(), rows: Candidate[] = [];
    data.writeUInt32LE(data.length);
    let initial = true;
    for (;;) {
      check();
      const available = api.entry(handle, data, initial);
      check();
      if (!available) break;
      initial = false;
      const pid = data.readUInt32LE(8), parentPid = data.readUInt32LE(api.pointerSize === 8 ? 32 : 24);
      if (ids.has(pid)) throw new Error("The Windows process inventory contains duplicate process identifiers.");
      ids.add(pid);
      if (pid > 0) rows.push({ pid, parentPid, group: null });
    }
    if (rows.length === 0) throw new Error("The Windows process inventory has no complete positive process candidates.");
    return rows;
  });
};
