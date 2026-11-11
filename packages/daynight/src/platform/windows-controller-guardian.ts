import { loadWindowsJobKernel, WindowsJobError } from "./windows-job.js";
import type { WindowsCommandJobKernel } from "./windows-job.js";
import { captureWindowsProcessProof } from "../commands/controller/windows-process-proof.js";
import type { ProcessProof } from "../commands/controller/process-proof.js";

export type WindowsControllerGuardianKernel = WindowsCommandJobKernel & {
  captureProof(pid: number): Promise<ProcessProof>;
  openGuardian(pid: number): unknown;
  duplicateJob(guardian: unknown, sourceHandle: string): unknown;
  decodeDuplicatedJob(sourceHandle: string): unknown;
  sameJob(left: unknown, right: unknown): boolean;
  handleValue(handle: unknown): string;
  killOnCloseConfirmed(handle: unknown): void;
  hasKillOnClose(handle: unknown): boolean;
  isSealed(handle: unknown): boolean;
  createWake(name: string): unknown;
  consumeWake(handle: unknown): boolean;
  wake(name: string): void;
};

export class WindowsGuardianDuplicateDecodeError extends Error {
  constructor(readonly rawHandle: string, options?: ErrorOptions) { super("The duplicated Windows Job handle could not be decoded; original ownership is retained.", options); this.name = "WindowsGuardianDuplicateDecodeError"; }
}

/** Each kernel call is synchronous and must return before its handle can be released. */
export const loadWindowsControllerGuardianKernel = async (): Promise<WindowsControllerGuardianKernel> => {
  const base = await loadWindowsJobKernel(), koffi = await import("koffi"), dll = koffi.load("kernel32.dll");
  const lastError = dll.func("uint32_t __stdcall GetLastError()");
  const setLastError = dll.func("void __stdcall SetLastError(uint32_t code)");
  const openProcess = dll.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const duplicate = dll.func("int __stdcall DuplicateHandle(void *sourceProcess, uintptr_t source, void *targetProcess, void *target, uint32_t access, int inherit, uint32_t options)");
  const currentProcess = dll.func("void * __stdcall GetCurrentProcess()");
  const compare = koffi.load("kernelbase.dll").func("int __stdcall CompareObjectHandles(void *left, void *right)");
  const query = dll.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)");
  const createEvent = dll.func("void * __stdcall CreateEventW(void *security, int manual, int initial, str16 name)");
  const openEvent = dll.func("void * __stdcall OpenEventW(uint32_t access, int inherit, str16 name)");
  const setEvent = dll.func("int __stdcall SetEvent(void *handle)");
  const wait = dll.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const pointerSize = koffi.sizeof("uintptr_t");
  if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported Windows guardian handle size.");
  const basic = koffi.struct({ PerProcessUserTimeLimit: "int64_t", PerJobUserTimeLimit: "int64_t", LimitFlags: "uint32_t", MinimumWorkingSetSize: "size_t", MaximumWorkingSetSize: "size_t", ActiveProcessLimit: "uint32_t", Affinity: "uintptr_t", PriorityClass: "uint32_t", SchedulingClass: "uint32_t" });
  const counters = koffi.struct({ ReadOperationCount: "uint64_t", WriteOperationCount: "uint64_t", OtherOperationCount: "uint64_t", ReadTransferCount: "uint64_t", WriteTransferCount: "uint64_t", OtherTransferCount: "uint64_t" });
  const extended = koffi.struct({ BasicLimitInformation: basic, IoInfo: counters, ProcessMemoryLimit: "size_t", JobMemoryLimit: "size_t", PeakProcessMemoryUsed: "size_t", PeakJobMemoryUsed: "size_t" });
  const flagOffset = koffi.offsetof(extended, "BasicLimitInformation") + koffi.offsetof(basic, "LimitFlags");
  const limitOffset = koffi.offsetof(extended, "BasicLimitInformation") + koffi.offsetof(basic, "ActiveProcessLimit");
  const failure = (stage: string) => new WindowsJobError(stage, lastError() as number);
  const limits = (handle: unknown) => {
    const data = Buffer.alloc(koffi.sizeof(extended)), returned = Buffer.alloc(4);
    if (!query(handle, 9, data, data.length, returned)) throw failure("guardian-query-limits");
    if (returned.readUInt32LE() !== data.length) throw new Error("Invalid Windows guardian Job limits.");
    return { flags: data.readUInt32LE(flagOffset), limit: data.readUInt32LE(limitOffset) };
  };
  return {
    ...base,
    captureProof: pid => captureWindowsProcessProof(pid, 15_000),
    openGuardian: pid => {
      const handle: unknown = openProcess(0x00101040, 0, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | DUP_HANDLE
      if (handle === null) throw failure("open-guardian");
      return handle;
    },
    duplicateJob: (guardian, sourceHandle) => {
      if (!/^[1-9][0-9]{0,19}$/.test(sourceHandle)) throw new Error("Invalid original Windows Job handle.");
      const value = BigInt(sourceHandle), max = (1n << BigInt(pointerSize * 8)) - 1n;
      if (value > max) throw new Error("Original Windows Job handle does not fit the native pointer size.");
      const out = Buffer.alloc(pointerSize), current: unknown = currentProcess();
      if (!duplicate(guardian, pointerSize === 8 ? value : Number(value), current, out, 0, 0, 2)) throw failure("duplicate-original-job");
      const address = pointerSize === 8 ? out.readBigUInt64LE() : BigInt(out.readUInt32LE());
      if (address === 0n) throw new Error("Duplicated Windows Job handle is null.");
      try { return koffi.decode(out, "void *"); }
      catch (error) { throw new WindowsGuardianDuplicateDecodeError(address.toString(), { cause: error }); }
    },
    decodeDuplicatedJob: sourceHandle => {
      if (!/^[1-9][0-9]{0,19}$/.test(sourceHandle)) throw new Error("Invalid retained Windows Job handle.");
      const address = BigInt(sourceHandle), max = (1n << BigInt(pointerSize * 8)) - 1n;
      if (address > max) throw new Error("Retained Windows Job handle does not fit the native pointer size.");
      const out = Buffer.alloc(pointerSize);
      if (pointerSize === 8) out.writeBigUInt64LE(address); else out.writeUInt32LE(Number(address));
      return koffi.decode(out, "void *");
    },
    sameJob: (left, right) => compare(left, right) !== 0,
    handleValue: handle => BigInt.asUintN(pointerSize * 8, koffi.address(handle)).toString(),
    killOnCloseConfirmed: handle => { base.killOnClose(handle); if ((limits(handle).flags & 0x2000) === 0) throw new Error("Windows guardian kill-on-close was not confirmed."); },
    hasKillOnClose: handle => (limits(handle).flags & 0x2000) !== 0,
    isSealed: handle => { const value = limits(handle); return (value.flags & 0x8) !== 0 && value.limit === 0; },
    createWake: name => {
      setLastError(0);
      const handle: unknown = createEvent(null, 0, 0, name), code = lastError() as number;
      if (handle === null) throw new WindowsJobError("create-guardian-event", code);
      if (code === 183) { base.close(handle); throw new WindowsJobError("guardian-event-already-exists", code); }
      return handle;
    },
    consumeWake: handle => { const result = wait(handle, 0) as number; if (result === 0) return true; if (result === 258) return false; throw failure("wait-guardian-event"); },
    wake: name => {
      const handle: unknown = openEvent(2, 0, name);
      if (handle === null) throw failure("open-guardian-event");
      let error: unknown;
      try { if (!setEvent(handle)) throw failure("signal-guardian-event"); }
      catch (cause) { error = cause; }
      try { base.close(handle); } catch (cause) { if (error !== undefined) throw new AggregateError([error, cause], "Guardian event signaling and handle release failed.", { cause: error }); throw cause; }
      if (error !== undefined) throw error;
    },
  };
};
