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
  exitCode(handle: unknown): number;
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
  const exitCode = win32.func("int __stdcall GetExitCodeProcess(void *process, void *exitCode)");
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
    exitCode: handle => {
      const code = Buffer.alloc(4);
      if (exitCode(handle, code) === 0) throw fail("exit-code");
      return code.readUInt32LE();
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

const readBirth = (api: ProcessKernel, handle: unknown, checkDeadline: () => void): string => {
  const creation = Buffer.alloc(8);
  api.times(handle, creation); checkDeadline();
  return birth(creation.readBigUInt64LE());
};

const readHandleProof = (api: ProcessKernel, handle: unknown, pid: number, startedAt: string, checkDeadline: () => void): ProcessProof => {
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
    return { pid, parentPid: Number(parentPid), processGroupId: null, startedAt, commandHash: createHash("sha256").update(command).digest("hex") };
};

const validatePid = (pid: number): void => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Invalid process identity.");
};
const validateTimeout = (timeoutMs: number): void => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Process identity timeout must be a positive supported integer.");
};
const absoluteDeadline = (deadline: number, operation: string): (() => void) => {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid Windows process deadline.");
  return () => { if (Date.now() >= deadline) throw new Error(`${operation} exceeded its deadline.`); };
};
const processKernel = async (checkDeadline: () => void): Promise<ProcessKernel> => {
  checkDeadline();
  const api = await (kernel ??= loadKernel());
  checkDeadline();
  if (api.pointerSize !== 4 && api.pointerSize !== 8) throw new Error("Unsupported Windows process pointer size.");
  return api;
};
const withHandle = <T>(api: ProcessKernel, handle: unknown, operation: string, action: () => T): T => {
  let result: T | undefined, failure: unknown, failed = false;
  try { result = action(); }
  catch (error) { failed = true; failure = error; }
  try { api.close(handle); }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], `${operation} and handle release failed.`, { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  return result!;
};
const processMissing = (error: unknown): boolean => error instanceof WindowsProcessProofError && error.stage === "open-process" && error.domain === "Win32" && error.code === 87;
const processTerminating = (error: unknown): boolean => error instanceof WindowsProcessProofError && error.domain === "NTSTATUS" && (error.code >>> 0) === 0xc000010a;

type WindowsProcessState = "running" | "stopped" | "replaced" | "exiting";
type WindowsProcessMismatch = { status: string | null; sameBirth: boolean; sameParent: boolean; sameGroup: boolean; sameCommand: boolean };
const inspectHandle = (api: ProcessKernel, handle: unknown, proof: ProcessProof, checkDeadline: () => void, onMismatch?: (evidence: WindowsProcessMismatch) => void, conflictMessage = "The original Windows process has inconsistent identity evidence; ownership remains unknown."): WindowsProcessState => {
  checkDeadline();
  const startedAt = readBirth(api, handle, checkDeadline);
  if (startedAt !== proof.startedAt) {
    // A different birth proves the original has gone. Its parent and command
    // are not read or accepted as evidence for the original process.
    onMismatch?.({ status: null, sameBirth: false, sameParent: false, sameGroup: proof.processGroupId === null, sameCommand: false });
    return "replaced";
  }
  if (api.wait(handle, 0)) { checkDeadline(); return "stopped"; }
  checkDeadline();
  // Windows can publish an exit code before pending I/O finishes and the
  // process handle becomes signaled. Exit status permits waiting only.
  // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
  const exitCode = api.exitCode(handle); checkDeadline();
  if (exitCode !== 259) return "exiting";
  let observed: ProcessProof;
  try { observed = readHandleProof(api, handle, proof.pid, startedAt, checkDeadline); }
  catch (error) {
    if (!processTerminating(error)) throw error;
    checkDeadline();
    return "exiting";
  }
  if (observed.commandHash !== proof.commandHash || observed.parentPid !== proof.parentPid || observed.processGroupId !== proof.processGroupId) throw new Error(conflictMessage);
  checkDeadline();
  return "running";
};
const waitForOriginalExit = (api: ProcessKernel, handle: unknown, deadline: number, checkDeadline: () => void): void => {
  checkDeadline();
  const remaining = Math.min(2_147_483_647, deadline - Date.now());
  if (!api.wait(handle, remaining)) throw new Error("The original Windows process did not finish exiting by its deadline.");
  checkDeadline();
};
const retainOriginalHandle = (api: ProcessKernel, proof: ProcessProof, checkDeadline: () => void): unknown | undefined => {
  checkDeadline();
  let handle: unknown;
  try { handle = api.open(proof.pid, 0x101000); }
  catch (error) { if (processMissing(error)) { checkDeadline(); return; } throw error; }
  let state: WindowsProcessState | undefined, failure: unknown, failed = false;
  try { state = inspectHandle(api, handle, proof, checkDeadline); }
  catch (error) { failed = true; failure = error; }
  if (!failed && (state === "running" || state === "exiting")) return handle;
  try { api.close(handle); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Windows process retention and handle release failed.", { cause: failure }); throw error; }
  if (failed) throw failure;
};

/** Native calls retain one process handle; deadlines are checked between calls,
 * including library loading. A running kernel call is joined, never cancelled.
 */
export const captureWindowsProcessProof = async (pid: number, timeoutMs: number): Promise<ProcessProof> => {
  validatePid(pid); validateTimeout(timeoutMs);
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Windows process identity observation exceeded its deadline."); };
  const api = await processKernel(checkDeadline);
  const handle = api.open(pid);
  const proof = withHandle(api, handle, "Windows process identity acquisition", () => {
    checkDeadline();
    const proof = readHandleProof(api, handle, pid, readBirth(api, handle, checkDeadline), checkDeadline);
    checkDeadline();
    return proof;
  });
  checkDeadline();
  return proof;
};

/** Windows liveness is observed on one birth-fenced synchronizable handle.
 * A changed exit code or a terminating native query never proves completion.
 */
export const inspectWindowsProcessProof = async (proof: ProcessProof, timeoutMs: number, onMismatch?: (evidence: WindowsProcessMismatch) => void): Promise<WindowsProcessState> => {
  validatePid(proof.pid); validateTimeout(timeoutMs);
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Windows process identity observation exceeded its deadline."); };
  const api = await processKernel(checkDeadline);
  let handle: unknown;
  try { handle = api.open(proof.pid, 0x101000); }
  catch (error) { if (processMissing(error)) { checkDeadline(); return "stopped"; } throw error; }
  const state = withHandle(api, handle, "Windows process observation", () => inspectHandle(api, handle, proof, checkDeadline, onMismatch));
  checkDeadline();
  return state;
};

/** All retained originals are pinned before stop runs. Successful Job termination
 * and an empty inventory still require these same handles to become signaled.
 */
export const withWindowsProcessStopHandles = async (proofs: readonly ProcessProof[], deadline: number, stop: () => Promise<void>): Promise<void> => {
  for (const proof of proofs) validatePid(proof.pid);
  const checkDeadline = absoluteDeadline(deadline, "Windows complete process stop");
  const api = await processKernel(checkDeadline), handles: unknown[] = [];
  let failure: unknown, failed = false;
  try {
    for (const proof of proofs) {
      const handle = retainOriginalHandle(api, proof, checkDeadline);
      if (handle !== undefined) handles.push(handle);
    }
    checkDeadline();
    await stop();
    checkDeadline();
    for (const handle of handles) waitForOriginalExit(api, handle, deadline, checkDeadline);
  } catch (error) { failed = true; failure = error; }
  const failures: unknown[] = failed ? [failure] : [];
  for (const handle of handles.reverse()) {
    try { api.close(handle); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 1) throw new AggregateError(failures, "Windows complete process stop and handle release failed.", { cause: failures[0] });
  if (failures.length === 1) throw failures[0];
  checkDeadline();
};

/** The handle pins the inspected instance through termination and the bounded wait. */
export const stopWindowsBootstrapProcess = async (proof: ProcessProof, deadline: number): Promise<void> => {
  validatePid(proof.pid);
  const checkDeadline = absoluteDeadline(deadline, "Windows bootstrap stop"), api = await processKernel(checkDeadline);
  let handle: unknown;
  try { handle = api.open(proof.pid, 0x101001); } // QUERY_LIMITED_INFORMATION | SYNCHRONIZE | TERMINATE
  catch (error) { if (processMissing(error)) { checkDeadline(); return; } throw error; }
  let terminationFailure: WindowsProcessProofError | undefined, failure: unknown, failed = false;
  try {
    const state = inspectHandle(api, handle, proof, checkDeadline, undefined, "Windows bootstrap process identity mismatch.");
    if (state === "replaced") throw new ControllerBootstrapReplacedError();
    if (state !== "stopped") {
      let completed = false;
      if (state === "running") {
        try { api.terminate(handle); }
        catch (error) {
          if (!(error instanceof WindowsProcessProofError) || error.stage !== "terminate-process" || error.domain !== "Win32" || error.code !== 5) throw error;
          // TerminateProcess reports access denied for an already terminated
          // process. Completion or exit transition must come from this held
          // original handle; a live access denial remains the original error.
          // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
          terminationFailure = error;
          checkDeadline();
          completed = api.wait(handle, 0); checkDeadline();
          if (!completed) {
            const exitCode = api.exitCode(handle); checkDeadline();
            if (exitCode === 259) throw error;
          }
        }
        checkDeadline();
      }
      if (!completed) waitForOriginalExit(api, handle, deadline, checkDeadline);
    }
  } catch (error) { failed = true; failure = error; }
  const failures: unknown[] = [];
  if (failed) {
    if (terminationFailure !== undefined && failure !== terminationFailure) failures.push(terminationFailure);
    failures.push(failure);
  }
  try { api.close(handle); }
  catch (error) {
    if (failures.length === 0 && terminationFailure !== undefined) failures.push(terminationFailure);
    failures.push(error);
  }
  if (failures.length === 0) {
    try { checkDeadline(); }
    catch (error) { if (terminationFailure !== undefined) failures.push(terminationFailure); failures.push(error); }
  }
  if (failures.length > 1) throw new AggregateError(failures, "Windows bootstrap stop failed.", { cause: failures[0] });
  if (failures.length === 1) throw failures[0];
};

/** Hold the process handle through identity and Job membership verification. */
export const verifyWindowsJobMember = async (proof: ProcessProof, deadline: number, belongs: (handle: unknown) => boolean): Promise<boolean> => {
  validatePid(proof.pid);
  const checkDeadline = absoluteDeadline(deadline, "Windows Job process verification"), api = await processKernel(checkDeadline);
  let handle: unknown;
  try { handle = api.open(proof.pid, 0x101000); }
  catch (error) { if (processMissing(error)) { checkDeadline(); return false; } throw error; }
  const result = withHandle(api, handle, "Windows Job process verification", () => {
    const state = inspectHandle(api, handle, proof, checkDeadline, undefined, "Windows Job member has conflicting original process identity.");
    if (state === "stopped" || state === "replaced") return false;
    const result = belongs(handle); checkDeadline();
    return result;
  });
  checkDeadline();
  return result;
};
