import { createHash } from "node:crypto";
import { ControllerBootstrapReplacedError } from "./bootstrap-error.js";
import { performance } from "node:perf_hooks";
import type { ProcessProof } from "./process-proof.js";

export class WindowsProcessProofError extends Error {
  constructor(readonly stage: string, readonly code: number, readonly domain: "Win32" | "NTSTATUS") {
    super(`Windows process identity ${stage} failed (${domain} 0x${(code >>> 0).toString(16)}).`);
    this.name = "WindowsProcessProofError";
  }
}

type ProcessKernel = {
  readonly pointerSize: number;
  open(pid: number, access?: number): unknown;
  terminate(handle: unknown): void;
  wait(handle: unknown, timeout: number): boolean;
  times(handle: unknown, creation: Buffer): void;
  query(handle: unknown, kind: number, data: Buffer): number;
  address(data: Buffer): bigint;
  close(handle: unknown): void;
};
let kernel: Promise<ProcessKernel> | undefined;
const loadKernel = async (): Promise<ProcessKernel> => {
  const koffi = await import("koffi");
  const win32 = koffi.load("kernel32.dll"), nt = koffi.load("ntdll.dll");
  const open = win32.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const times = win32.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const terminate = win32.func("int __stdcall TerminateProcess(void *process, uint32_t exitCode)");
  const wait = win32.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const close = win32.func("int __stdcall CloseHandle(void *handle)");
  const lastError = win32.func("uint32_t __stdcall GetLastError()");
  const query = nt.func("int32_t __stdcall NtQueryInformationProcess(void *process, uint32_t kind, void *data, uint32_t size, void *returned)");
  const fail = (stage: string) => new WindowsProcessProofError(stage, lastError() as number, "Win32");
  return {
    pointerSize: koffi.sizeof("uintptr_t"),
    open: (pid, access = 0x1000) => {
      const handle: unknown = open(access, 0, pid);
      if (handle === null) throw fail("open-process");
      return handle;
    },
    terminate: handle => { if (terminate(handle, 1) === 0) throw fail("terminate-process"); },
    wait: (handle, timeout) => {
      const status = wait(handle, timeout) as number;
      if (status === 0) return true;
      if (status === 258) return false;
      throw fail("wait-process");
    },
    times: (handle, creation) => {
      if (times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) throw fail("creation-time");
    },
    query: (handle, kind, data) => {
      const returned = Buffer.alloc(4);
      const status = query(handle, kind, data, data.length, returned) as number;
      if (status < 0) throw new WindowsProcessProofError(kind === 0 ? "basic-information" : "command-line", status, "NTSTATUS");
      return returned.readUInt32LE();
    },
    address: data => koffi.address(data),
    close: handle => { if (close(handle) === 0) throw fail("close-process-handle"); },
  };
};

const pointer = (data: Buffer, offset: number, size: number): bigint => size === 8 ? data.readBigUInt64LE(offset) : BigInt(data.readUInt32LE(offset));
const birth = (fileTime: bigint): string => {
  // CIM_DATETIME stores microseconds; DateTime's round-trip format prints seven
  // fractional digits. Preserve that persisted representation without rounding.
  // https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime
  const ticks = fileTime / 10n * 10n, unixTicks = ticks - 116444736000000000n;
  if (unixTicks < 0n || unixTicks > 2534023007999999990n) throw new Error("Invalid Windows process creation time.");
  const seconds = unixTicks / 10000000n, fraction = (unixTicks % 10000000n).toString().padStart(7, "0");
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
};

const readHandleProof = (api: ProcessKernel, handle: unknown, pid: number, checkDeadline: () => void): ProcessProof => {
    const creation = Buffer.alloc(8);
    api.times(handle, creation); checkDeadline();
    const basic = Buffer.alloc(api.pointerSize * 6);
    if (api.query(handle, 0, basic) !== basic.length) throw new Error("Invalid Windows process basic information size.");
    checkDeadline();
    const observedPid = pointer(basic, api.pointerSize * 4, api.pointerSize), parentPid = pointer(basic, api.pointerSize * 5, api.pointerSize);
    if (observedPid !== BigInt(pid) || parentPid > 0xffff_ffffn) throw new Error("Windows process identity cannot be established.");
    // ProcessCommandLineInformation (60), available since Windows 8.1, returns
    // UNICODE_STRING followed by its full UTF-16 value. The maximum USHORT
    // length bounds the allocation; no PEB reads or executable-path substitute.
    // https://github.com/winsiderss/systeminformer/blob/0a4975a4763ad202747397ef5daf5893849b5b00/phlib/nativeprocess.c#L1922-L1972
    const header = api.pointerSize * 2, data = Buffer.alloc(header + 65536);
    const returned = api.query(handle, 60, data); checkDeadline();
    if (returned < header || returned > data.length) throw new Error("Invalid Windows process command-line information size.");
    const length = data.readUInt16LE(0), maximum = data.readUInt16LE(2);
    const offset = pointer(data, api.pointerSize, api.pointerSize) - api.address(data);
    if (length === 0 || length % 2 !== 0 || maximum % 2 !== 0 || length > maximum || offset % 2n !== 0n || offset < BigInt(header) || offset + BigInt(maximum) > BigInt(returned)) throw new Error("Invalid Windows process command-line identity.");
    const command = data.toString("utf16le", Number(offset), Number(offset) + length);
    return { pid, parentPid: Number(parentPid), processGroupId: null, startedAt: birth(creation.readBigUInt64LE()), commandHash: createHash("sha256").update(command).digest("hex") };
};

/** Native calls retain one process handle; deadlines are checked between calls,
 * including library loading. A running kernel call is joined, never cancelled.
 */
export const captureWindowsProcessProof = async (pid: number, timeoutMs: number): Promise<ProcessProof> => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Invalid process identity.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Process identity timeout must be a positive supported integer.");
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Windows process identity observation exceeded its deadline."); };
  const api = await (kernel ??= loadKernel());
  checkDeadline();
  if (api.pointerSize !== 4 && api.pointerSize !== 8) throw new Error("Unsupported Windows process pointer size.");
  const handle = api.open(pid);
  let proof: ProcessProof | undefined, failure: unknown, failed = false;
  try {
    checkDeadline();
    proof = readHandleProof(api, handle, pid, checkDeadline);
    checkDeadline();
  } catch (error) { failed = true; failure = error; }
  try { api.close(handle); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], "Windows process identity acquisition and handle release failed.", { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  checkDeadline();
  return proof!;
};

/** The handle pins the inspected instance through termination and the bounded wait. */
export const stopWindowsBootstrapProcess = async (proof: ProcessProof, deadline: number): Promise<void> => {
  if (!Number.isSafeInteger(proof.pid) || proof.pid <= 0 || proof.pid > 2_147_483_647) throw new Error("Invalid process identity.");
  const checkDeadline = () => { if (Date.now() >= deadline) throw new Error("Windows bootstrap stop exceeded its deadline."); };
  checkDeadline();
  const api = await (kernel ??= loadKernel());
  checkDeadline();
  if (api.pointerSize !== 4 && api.pointerSize !== 8) throw new Error("Unsupported Windows process pointer size.");
  const handle = api.open(proof.pid, 0x101001); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE | TERMINATE
  let failure: unknown, failed = false;
  try {
    checkDeadline();
    const observed = readHandleProof(api, handle, proof.pid, checkDeadline);
    if (observed.startedAt !== proof.startedAt) throw new ControllerBootstrapReplacedError();
    if (observed.commandHash !== proof.commandHash || observed.parentPid !== proof.parentPid || observed.processGroupId !== proof.processGroupId) throw new Error("Windows bootstrap process identity mismatch.");
    checkDeadline();
    if (!api.wait(handle, 0)) {
      api.terminate(handle);
      checkDeadline();
      const remaining = Math.min(2_147_483_647, Math.max(0, deadline - Date.now()));
      if (!api.wait(handle, remaining)) throw new Error("Windows bootstrap stop exceeded its deadline.");
      checkDeadline();
    }
  } catch (error) { failed = true; failure = error; }
  try { api.close(handle); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Windows bootstrap stop and handle release failed.", { cause: failure }); throw error; }
  if (failed) throw failure;
};
