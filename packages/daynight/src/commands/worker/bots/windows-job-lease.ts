export type WindowsBotJobKernel = {
  create(name: string): unknown;
  killOnClose(handle: unknown): void;
  assign(handle: unknown, pid: number): void;
  inspect(handle: unknown): readonly number[];
  terminate(handle: unknown): void;
  close(handle: unknown): void;
};

export class WindowsBotJobError extends Error {
  constructor(readonly stage: string, readonly win32Code: number) {
    super(`Windows Bot probe Job Object ${stage} failed (Win32 ${win32Code}).`);
    this.name = "WindowsBotJobError";
  }
}

export type WindowsBotJobLease = {
  readonly name: string;
  assign(pid: number): void;
  inspect(): readonly number[];
  terminate(): void;
  /** Close only after the members and the owning guardian have stopped. */
  close(): void;
};

export class WindowsBotJobSetupError extends Error {
  constructor(readonly lease: WindowsBotJobLease) {
    super("Windows Bot probe Job Object setup failed with an unclosed owned handle.");
    this.name = "WindowsBotJobSetupError";
  }
}

let kernel: Promise<WindowsBotJobKernel> | undefined;
const loadKernel = async (): Promise<WindowsBotJobKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("kernel32.dll");
  const create = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
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
  const pointerSize = koffi.sizeof("uintptr_t");
  const failure = (stage: string) => new WindowsBotJobError(stage, lastError() as number);
  return {
    create: name => {
      setLastError(0);
      const handle: unknown = create(null, name), code = lastError() as number;
      if (handle === null) throw new WindowsBotJobError("create", code);
      if (code === 183) { close(handle); throw new WindowsBotJobError("identity-already-exists", code); }
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
      if (data.readUInt32LE(0) < count || 8 + count * pointerSize > data.length) throw new Error("Invalid Windows Bot probe Job Object inventory.");
      const pids = Array.from({ length: count }, (_, index) => pointerSize === 8 ? Number(data.readBigUInt64LE(8 + index * pointerSize)) : data.readUInt32LE(8 + index * pointerSize));
      if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid Windows Bot probe Job Object process identity.");
      return pids;
    },
    terminate: handle => { if (terminate(handle, 1) === 0) throw failure("terminate-members"); },
    close: handle => { if (close(handle) === 0) throw failure("close-job-handle"); },
  };
};

/**
 * Keep the original handle while any process can belong to the job. A temporary
 * object's name disappears when its last handle closes even if process references
 * keep its body alive; reopening by name cannot replace this ownership lease.
 */
export const createWindowsBotJobLease = async (launchId: string, suppliedKernel?: WindowsBotJobKernel): Promise<WindowsBotJobLease> => {
  const name = `Local\\Daynight-${launchId}`;
  if (!/^Local\\Daynight-[0-9a-f-]{36}$/.test(name)) throw new Error("Invalid Windows Bot probe Job Object identity.");
  const api = suppliedKernel ?? await (kernel ??= loadKernel());
  const handle = api.create(name);
  let closed = false;
  const lease: WindowsBotJobLease = {
    name,
    assign: pid => {
      if (closed) throw new Error("The Windows Bot probe Job Object handle is closed.");
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error("Invalid Windows Bot probe process ID.");
      api.assign(handle, pid);
    },
    inspect: () => closed ? [] : api.inspect(handle),
    terminate: () => { if (!closed) api.terminate(handle); },
    close: () => {
      if (closed) return;
      if (api.inspect(handle).length !== 0) throw new Error("Cannot close the Windows Bot probe Job Object while members remain.");
      api.close(handle); closed = true;
    },
  };
  try { api.killOnClose(handle); }
  catch (error) {
    try { lease.close(); }
    catch { throw new WindowsBotJobSetupError(lease); }
    throw error;
  }
  return lease;
};
