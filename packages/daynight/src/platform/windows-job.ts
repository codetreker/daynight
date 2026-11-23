export type WindowsJobKernel = {
  create(name: string): unknown;
  killOnClose(handle: unknown): void;
  assign(handle: unknown, pid: number): void;
  inspect(handle: unknown): readonly number[];
  terminate(handle: unknown): void;
  close(handle: unknown): void;
};

export class WindowsJobError extends Error {
  constructor(readonly stage: string, readonly win32Code: number) {
    super(`Windows Job Object ${stage} failed (Win32 ${win32Code}).`);
    this.name = "WindowsJobError";
  }
}

export type WindowsJobProcess = { pid: number; parentPid: number; birth: bigint };
export type WindowsOwnedJobKernel = WindowsJobKernel & {
  open(pid: number): unknown;
  identity(process: unknown): WindowsJobProcess;
  assignHandle(job: unknown, process: unknown): void;
  contains(job: unknown, process: unknown): boolean;
  signaled(process: unknown): boolean;
  active(job: unknown): number;
  closeProcess(process: unknown): void;
};
export type WindowsNamedJobKernel = WindowsOwnedJobKernel & { openNamed(name: string): unknown | null };

export const loadWindowsJobKernel = async (): Promise<WindowsNamedJobKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("kernel32.dll");
  const create = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const openNamed = library.func("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const setLastError = library.func("void __stdcall SetLastError(uint32_t code)");
  const openProcess = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const assign = library.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const query = library.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)");
  const set = library.func("int __stdcall SetInformationJobObject(void *job, int kind, void *data, uint32_t size)");
  const terminate = library.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const basic = koffi.struct({
    PerProcessUserTimeLimit: "int64_t", PerJobUserTimeLimit: "int64_t", LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "size_t", MaximumWorkingSetSize: "size_t", ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t", PriorityClass: "uint32_t", SchedulingClass: "uint32_t",
  });
  const counters = koffi.struct({ ReadOperationCount: "uint64_t", WriteOperationCount: "uint64_t", OtherOperationCount: "uint64_t", ReadTransferCount: "uint64_t", WriteTransferCount: "uint64_t", OtherTransferCount: "uint64_t" });
  const extended = koffi.struct({ BasicLimitInformation: basic, IoInfo: counters, ProcessMemoryLimit: "size_t", JobMemoryLimit: "size_t", PeakProcessMemoryUsed: "size_t", PeakJobMemoryUsed: "size_t" });
  const nt = koffi.load("ntdll.dll");
  const information = nt.func("int32_t __stdcall NtQueryInformationProcess(void *process, uint32_t kind, void *data, uint32_t size, void *returned)");
  const times = library.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const wait = library.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const contains = library.func("int __stdcall IsProcessInJob(void *process, void *job, void *result)");
  const pointerSize = koffi.sizeof("uintptr_t");
  if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported Windows process pointer size.");
  const failure = (stage: string) => new WindowsJobError(stage, lastError() as number);
  return {
    openNamed: name => {
      const handle: unknown = openNamed(12, 0, name);
      if (handle !== null) return handle;
      const code = lastError() as number;
      if (code === 2) return null;
      throw new WindowsJobError("open-named-job", code);
    },
    open: pid => {
      const handle: unknown = openProcess(0x00101101, 0, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | SET_QUOTA | TERMINATE
      if (handle === null) {
        const code = lastError() as number;
        if (code === 87) return null;
        throw new WindowsJobError("open-owned-process", code);
      }
      return handle;
    },
    identity: handle => {
      const birth = Buffer.alloc(8), data = Buffer.alloc(pointerSize * 6), returned = Buffer.alloc(4);
      if (times(handle, birth, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) throw failure("process-times");
      const status = information(handle, 0, data, data.length, returned) as number;
      if (status < 0) throw new Error(`Windows Job process identity failed (NTSTATUS 0x${(status >>> 0).toString(16)}).`);
      const pointer = (offset: number) => pointerSize === 8 ? Number(data.readBigUInt64LE(offset)) : data.readUInt32LE(offset);
      const pid = pointer(pointerSize * 4), parentPid = pointer(pointerSize * 5), creation = birth.readBigUInt64LE();
      if (returned.readUInt32LE() !== data.length || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff ||
          !Number.isSafeInteger(parentPid) || parentPid < 0 || parentPid > 0xffff_ffff || creation <= 0n) throw new Error("Invalid Windows Job process identity.");
      return { pid, parentPid, birth: creation };
    },
    assignHandle: (job, process) => { if (assign(job, process) === 0) throw failure("assign-held-process"); },
    contains: (job, process) => {
      const result = Buffer.alloc(4);
      if (contains(process, job, result) === 0) throw failure("query-process-membership");
      return result.readUInt32LE() !== 0;
    },
    signaled: process => {
      const result = wait(process, 0) as number;
      if (result === 0) return true;
      if (result === 258) return false;
      throw failure("wait-process");
    },
    active: job => {
      const data = Buffer.alloc(48), returned = Buffer.alloc(4);
      if (query(job, 1, data, data.length, returned) === 0) throw failure("query-accounting");
      if (returned.readUInt32LE() !== data.length) throw new Error("Invalid Windows Job accounting information.");
      return data.readUInt32LE(40);
    },
    closeProcess: process => { if (close(process) === 0) throw failure("close-owned-process"); },
    create: name => {
      setLastError(0);
      const handle: unknown = create(null, name), code = lastError() as number;
      if (handle === null) throw new WindowsJobError("create", code);
      if (code === 183) { close(handle); throw new WindowsJobError("identity-already-exists", code); }
      return handle;
    },
    killOnClose: handle => {
      const limits = Buffer.alloc(koffi.sizeof(extended));
      limits.writeUInt32LE(0x2000, koffi.offsetof(extended, "BasicLimitInformation") + koffi.offsetof(basic, "LimitFlags"));
      if (set(handle, 9, limits, limits.length) === 0) throw failure("configure-kill-on-close");
    },
    assign: (handle, pid) => {
      const process: unknown = openProcess(0x101, 0, pid);
      if (process === null) throw failure("open-process");
      try { if (assign(handle, process) === 0) throw failure("assign-process"); }
      finally { if (close(process) === 0) throw failure("close-process-handle"); }
    },
    inspect: handle => {
      const data = Buffer.alloc(262_144);
      if (query(handle, 3, data, data.length, null) === 0) throw failure("query-members");
      const count = data.readUInt32LE(4);
      if (data.readUInt32LE(0) < count || 8 + count * pointerSize > data.length) throw new Error("Invalid Windows Job Object inventory.");
      const pids = Array.from({ length: count }, (_, index) => pointerSize === 8 ? Number(data.readBigUInt64LE(8 + index * pointerSize)) : data.readUInt32LE(8 + index * pointerSize));
      if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid Windows Job Object process identity.");
      return pids;
    },
    terminate: handle => { if (terminate(handle, 1) === 0) throw failure("terminate-members"); },
    close: handle => { if (close(handle) === 0) throw failure("close-job-handle"); },
  };
};
