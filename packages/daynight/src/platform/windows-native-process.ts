import { assertWindowsNativeChildPermission, WindowsNativeProcessError } from "./windows-native-command-data.js";
import type { WindowsNativeCommandData, WindowsNativeCommandDataApi } from "./windows-native-command-data.js";
export { assertWindowsNativeChildPermission, WindowsNativeProcessError } from "./windows-native-command-data.js";

/** Original handles are private capabilities; duplicateProcess supplies handles for Job observations. */
export type WindowsNativeCreatedProcess = {
  process: unknown;
  thread: unknown;
  pid: number;
  threadId: number;
};
export type WindowsNativeCreateOptions = WindowsNativeCommandData & {
  job: unknown;
  stdin: unknown;
  stdout: unknown;
  stderr: unknown;
};
export type WindowsNativeCreateResult = {
  created: WindowsNativeCreatedProcess | null;
  failure: unknown | undefined;
  cleanupErrors: readonly unknown[];
};
export type WindowsNativeProcessKernel = WindowsNativeCommandDataApi & {
  openPipeClient(name: string): unknown;
  serverPid(handle: unknown): number;
  write(handle: unknown, bytes: Buffer): void;
  openNullInput(): unknown;
  /** Consumes all three parent stdio handles, including when creation or finalization fails. */
  createSuspended(options: WindowsNativeCreateOptions): WindowsNativeCreateResult;
  duplicateProcess(process: unknown): unknown;
  signaled(process: unknown): boolean;
  exitCode(process: unknown): number;
  resume(thread: unknown): void;
  close(handle: unknown): void;
};

export const loadWindowsNativeProcessKernel = async (): Promise<WindowsNativeProcessKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("kernel32.dll");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const setLastError = library.func("void __stdcall SetLastError(uint32_t code)");
  const openFile = library.func("void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)");
  const pipeServer = library.func("int __stdcall GetNamedPipeServerProcessId(void *pipe, void *pid)");
  const writeFile = library.func("int __stdcall WriteFile(void *file, void *bytes, uint32_t size, void *written, void *overlapped)");
  const handleInformation = library.func("int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)");
  const initializeAttributes = library.func("int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, void *size)");
  const updateAttribute = library.func("int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t attribute, void *value, size_t size, void *previous, void *returned)");
  const deleteAttributes = library.func("void __stdcall DeleteProcThreadAttributeList(void *list)");
  const createProcess = library.func("int __stdcall CreateProcessW(str16 application, void *commandLine, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, str16 cwd, void *startup, void *information)");
  const resumeThread = library.func("uint32_t __stdcall ResumeThread(uintptr_t thread)");
  const exitCode = library.func("int __stdcall GetExitCodeProcess(uintptr_t process, void *code)");
  const duplicate = library.func("int __stdcall DuplicateHandle(void *sourceProcess, uintptr_t source, void *targetProcess, void *target, uint32_t access, int inherit, uint32_t options)");
  const currentProcess = library.func("void * __stdcall GetCurrentProcess()");
  const wait = library.func("uint32_t __stdcall WaitForSingleObject(uintptr_t handle, uint32_t milliseconds)");
  const closeHandle = library.func("int __stdcall CloseHandle(uintptr_t handle)");
  const fileAttributes = library.func("uint32_t __stdcall GetFileAttributesW(str16 file)");
  const needCwd = library.func("int __stdcall NeedCurrentDirectoryForExePathW(str16 file)");
  const compare = library.func("int __stdcall CompareStringOrdinal(str16 left, int leftLength, str16 right, int rightLength, int ignoreCase)");
  const readEnvironment = library.func("uint32_t __stdcall GetEnvironmentVariableW(str16 name, void *value, uint32_t size)");
  const shortPath = library.func("uint32_t __stdcall GetShortPathNameW(str16 file, void *value, uint32_t size)");
  const startupInfo = koffi.struct({
    cb: "uint32_t", lpReserved: "void *", lpDesktop: "void *", lpTitle: "void *",
    dwX: "uint32_t", dwY: "uint32_t", dwXSize: "uint32_t", dwYSize: "uint32_t",
    dwXCountChars: "uint32_t", dwYCountChars: "uint32_t", dwFillAttribute: "uint32_t", dwFlags: "uint32_t",
    wShowWindow: "uint16_t", cbReserved2: "uint16_t", lpReserved2: "void *",
    hStdInput: "void *", hStdOutput: "void *", hStdError: "void *",
  });
  const startupInfoEx = koffi.struct({ StartupInfo: startupInfo, lpAttributeList: "void *" });
  const processInfo = koffi.struct({ hProcess: "void *", hThread: "void *", dwProcessId: "uint32_t", dwThreadId: "uint32_t" });
  const pointerSize = koffi.sizeof("void *");
  if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported Windows native command pointer size.");
  const expected = pointerSize === 8 ? [104, 60, 80, 112, 104, 24, 16] : [68, 44, 56, 72, 68, 16, 8];
  const actual = [koffi.sizeof(startupInfo), koffi.offsetof(startupInfo, "dwFlags"), koffi.offsetof(startupInfo, "hStdInput"),
    koffi.sizeof(startupInfoEx), koffi.offsetof(startupInfoEx, "lpAttributeList"), koffi.sizeof(processInfo), koffi.offsetof(processInfo, "dwProcessId")];
  if (actual.some((value, index) => value !== expected[index])) throw new Error("Unsupported Windows native command structure layout.");
  const failure = (stage: string) => new WindowsNativeProcessError(stage, lastError() as number);
  type RetainedHandle = { address: bigint; closeAttempted: boolean };
  const retained = new WeakMap<object, RetainedHandle>();
  const pointer = (buffer: Buffer, offset = 0): bigint => pointerSize === 8 ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUInt32LE(offset));
  const keep = (address: bigint): unknown => { const handle = {}; retained.set(handle, { address, closeAttempted: false }); return handle; };
  const observation = (handle: unknown): RetainedHandle | undefined => typeof handle === "object" && handle !== null ? retained.get(handle) : undefined;
  const address = (handle: unknown): bigint => {
    const value = observation(handle);
    if (value?.closeAttempted) throw new Error("Windows native process handle close was already attempted.");
    return value === undefined ? koffi.address(handle) : value.address;
  };
  const scalar = (value: bigint): bigint | number => pointerSize === 8 ? value : Number(value);
  const close = (handle: unknown): void => {
    const value = address(handle), owned = observation(handle);
    if (owned !== undefined) owned.closeAttempted = true;
    if (!closeHandle(scalar(value))) throw failure("close-handle");
  };
  const open = (name: string, access: number, share: number): unknown => {
    const handle: unknown = openFile(name, access, share, null, 3, 0x80, null), code = lastError() as number;
    if (handle === null || BigInt.asUintN(pointerSize * 8, koffi.address(handle)) === (1n << BigInt(pointerSize * 8)) - 1n) throw new WindowsNativeProcessError("open-file", code);
    return handle;
  };
  const signaled = (handle: unknown): boolean => {
    const result = wait(scalar(address(handle)), 0) as number;
    if (result === 0) return true;
    if (result === 258) return false;
    if (result === 0xffff_ffff) throw failure("wait-process");
    throw new Error(`Unexpected Windows native process wait result ${result}.`);
  };
  const readWide = (size: number, read: (buffer: Buffer, count: number) => number, stage: string): string => {
    const buffer = Buffer.alloc(size * 2), length = read(buffer, size);
    if (length === 0) throw failure(stage);
    if (length >= size) throw new Error(`Windows native command ${stage} changed during preparation.`);
    return buffer.subarray(0, length * 2).toString("utf16le");
  };
  const createSuspended = (options: WindowsNativeCreateOptions): WindowsNativeCreateResult => {
    const stdio = [options.stdin, options.stdout, options.stderr];
    const uniqueStdio = [...new Map(stdio.map(handle => [koffi.address(handle), handle])).values()];
    const cleanupErrors: unknown[] = [];
    const attributeValues: Buffer[] = [];
    let attributes: Buffer | undefined, initialized = false, created: WindowsNativeCreatedProcess | null = null, primary: unknown;
    try {
      assertWindowsNativeChildPermission();
      const sizeBuffer = Buffer.alloc(pointerSize);
      setLastError(0);
      const sizing = initializeAttributes(null, 2, 0, sizeBuffer) as number, sizeError = lastError() as number;
      if (sizing !== 0 || sizeError !== 122) throw new WindowsNativeProcessError("size-process-attributes", sizeError);
      const size = pointerSize === 8 ? Number(sizeBuffer.readBigUInt64LE()) : sizeBuffer.readUInt32LE();
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid Windows process attribute storage size.");
      attributes = Buffer.alloc(size);
      if (!initializeAttributes(attributes, 2, 0, sizeBuffer)) throw failure("initialize-process-attributes");
      initialized = true;
      const handleList = Buffer.alloc(pointerSize * uniqueStdio.length), jobList = Buffer.alloc(pointerSize);
      attributeValues.push(handleList, jobList);
      koffi.encode(handleList, koffi.array("void *", uniqueStdio.length), uniqueStdio);
      koffi.encode(jobList, "void *", options.job);
      if (!updateAttribute(attributes, 0, 0x0002_0002, handleList, handleList.length, null, null)) throw failure("set-process-handle-list");
      if (!updateAttribute(attributes, 0, 0x0002_000d, jobList, jobList.length, null, null)) throw failure("set-process-job-list");
      const startup = Buffer.alloc(koffi.sizeof(startupInfoEx)), information = Buffer.alloc(koffi.sizeof(processInfo));
      koffi.encode(startup, startupInfoEx, { StartupInfo: {
        cb: startup.length, lpReserved: null, lpDesktop: null, lpTitle: null,
        dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
        dwFlags: 0x101, wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
        hStdInput: options.stdin, hStdOutput: options.stdout, hStdError: options.stderr,
      }, lpAttributeList: attributes });
      // Do not yield while these writer copies are inheritable: another spawn could keep their pipe alive.
      for (const handle of uniqueStdio) if (!handleInformation(handle, 1, 1)) throw failure("set-process-handle-inheritance");
      if (!createProcess(options.application, options.commandLine, null, null, 1, 0x0808_0404, options.environment, options.cwd, startup, information)) throw failure("create-process");
      // Retain the original native values before any opaque-pointer decoding or fallible finalization.
      const processAddress = pointer(information), threadAddress = pointer(information, pointerSize);
      created = { process: keep(processAddress), thread: keep(threadAddress), pid: information.readUInt32LE(pointerSize * 2), threadId: information.readUInt32LE(pointerSize * 2 + 4) };
      if (processAddress === 0n || threadAddress === 0n || !Number.isInteger(created.pid) || created.pid <= 0 ||
          !Number.isInteger(created.threadId) || created.threadId <= 0) throw new Error("Invalid Windows native process creation result.");
    } catch (error) { primary = error; }
    finally {
      if (initialized) { try { deleteAttributes(attributes); } catch (error) { cleanupErrors.push(error); } }
      attributeValues.splice(0);
      for (const handle of uniqueStdio) { try { close(handle); } catch (error) { cleanupErrors.push(error); } }
    }
    return { created, failure: primary, cleanupErrors };
  };
  return {
    openPipeClient: name => open(name, 0x0010_0083, 0),
    serverPid: handle => {
      const data = Buffer.alloc(4);
      if (!pipeServer(handle, data)) throw failure("query-pipe-server");
      const pid = data.readUInt32LE();
      if (pid === 0) throw new Error("Invalid Windows named pipe server identity.");
      return pid;
    },
    write: (handle, bytes) => {
      const written = Buffer.alloc(4);
      if (!writeFile(handle, bytes, bytes.length, written, null)) throw failure("write-pipe-frame");
      if (written.readUInt32LE() !== bytes.length) throw new Error("Windows native pipe did not accept the complete admission frame.");
    },
    openNullInput: () => open("NUL", 0x8000_0000, 3), createSuspended,
    duplicateProcess: process => {
      const destination = Buffer.alloc(pointerSize), current: unknown = currentProcess();
      if (!duplicate(current, scalar(address(process)), current, destination, 0, 0, 2)) throw failure("duplicate-process");
      const value = pointer(destination);
      if (value === 0n) throw new Error("Windows native process duplicate has no handle.");
      try { return koffi.decode(destination, "void *"); }
      catch (error) {
        if (!closeHandle(scalar(value))) throw new AggregateError([error, failure("close-process-duplicate")], "Windows native process observation could not be decoded or closed.");
        throw error;
      }
    },
    signaled,
    exitCode: process => {
      if (!signaled(process)) throw new Error("Windows native process has not signaled exit.");
      const code = Buffer.alloc(4);
      if (!exitCode(scalar(address(process)), code)) throw failure("query-process-exit");
      return code.readUInt32LE();
    },
    resume: thread => {
      const count = resumeThread(scalar(address(thread))) as number;
      if (count === 0xffff_ffff) throw failure("resume-process-thread");
      if (count !== 1) throw new Error(`Unexpected Windows native process suspend count ${count}.`);
    },
    close,
    environmentValue: name => {
      setLastError(0);
      const size = readEnvironment(name, null, 0) as number;
      if (size === 0) { const code = lastError() as number; if (code === 203) return undefined; throw new WindowsNativeProcessError("query-environment", code); }
      const buffer = Buffer.alloc(size * 2);
      setLastError(0);
      const length = readEnvironment(name, buffer, size) as number;
      if (length >= size) throw new Error("Windows environment changed during native command preparation.");
      if (length === 0) { const code = lastError() as number; if (code !== 0) throw new WindowsNativeProcessError("query-environment", code); }
      return buffer.subarray(0, length * 2).toString("utf16le");
    },
    compareOrdinal: (left, right) => {
      const result = compare(left, left.length, right, right.length, 1) as number;
      if (result === 0) throw failure("compare-environment-name");
      return result - 2;
    },
    needCurrentDirectory: () => needCwd("") !== 0,
    fileExists: file => { const attributes = fileAttributes(file) as number; return attributes !== 0xffff_ffff && (attributes & 0x10) === 0; },
    shortPath: file => {
      const size = shortPath(file, null, 0) as number;
      if (size === 0) throw failure("resolve-working-directory");
      return readWide(size, (buffer, count) => shortPath(file, buffer, count) as number, "resolve-working-directory");
    },
  };
};
