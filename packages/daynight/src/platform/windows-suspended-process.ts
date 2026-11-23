import path from "node:path";

export type SuspendedProcessOptions = {
  file: string;
  args: readonly string[];
  cwd?: string;
  environment: NodeJS.ProcessEnv;
};
export type WindowsSuspendedProcess = {
  readonly pid: number;
  resume(): void;
  terminate(): void;
  hasExited(): boolean;
  close(): void;
};

/** Quote one argument for the Windows C runtime, without invoking a shell. */
export const quoteWindowsProcessArgument = (value: string): string => {
  if (value.includes("\0")) throw new TypeError("Windows process arguments cannot contain NUL.");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
};

export const windowsProcessEnvironment = (environment: NodeJS.ProcessEnv): Buffer => {
  const keys = new Set<string>();
  const entries = Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined);
  for (const [key, value] of entries) {
    if (!key || key.includes("\0") || key.includes("=") && !/^=[a-z]:$/i.test(key) || value.includes("\0")) throw new TypeError("Invalid Windows process environment entry.");
    const normalized = key.toUpperCase();
    if (keys.has(normalized)) throw new TypeError("Windows process environment contains duplicate case-insensitive keys.");
    keys.add(normalized);
  }
  entries.sort(([left], [right]) => left.toUpperCase() < right.toUpperCase() ? -1 : left.toUpperCase() > right.toUpperCase() ? 1 : 0);
  return Buffer.from(`${entries.map(([key, value]) => `${key}=${value}`).join("\0")}\0\0`, "utf16le");
};

/**
 * The original process/thread handles remain owned until confirmed exit. No
 * instruction in the child executes before resume; callers assign its Job and
 * durably bind its birth identity before releasing this gate.
 */
export const createSuspendedProcess = async (options: SuspendedProcessOptions): Promise<WindowsSuspendedProcess> => {
  if (process.platform !== "win32") throw new Error("Suspended process creation is supported only on Windows.");
  if (!path.win32.isAbsolute(options.file) || options.file.includes("\0") || options.cwd !== undefined && (!path.win32.isAbsolute(options.cwd) || options.cwd.includes("\0"))) throw new TypeError("Windows suspended processes require absolute executable and working-directory paths.");
  const command = [options.file, ...options.args].map(quoteWindowsProcessArgument).join(" ");
  if (command.length + 1 > 32_767) throw new RangeError("Windows process command line exceeds its native limit.");
  const environment = windowsProcessEnvironment(options.environment);
  const koffi = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const startupType = koffi.struct({
    cb: "uint32_t", lpReserved: "void *", lpDesktop: "void *", lpTitle: "void *",
    dwX: "uint32_t", dwY: "uint32_t", dwXSize: "uint32_t", dwYSize: "uint32_t",
    dwXCountChars: "uint32_t", dwYCountChars: "uint32_t", dwFillAttribute: "uint32_t", dwFlags: "uint32_t",
    wShowWindow: "uint16_t", cbReserved2: "uint16_t", lpReserved2: "void *",
    hStdInput: "void *", hStdOutput: "void *", hStdError: "void *",
  });
  const informationType = koffi.struct({ hProcess: "void *", hThread: "void *", dwProcessId: "uint32_t", dwThreadId: "uint32_t" });
  const create = kernel.func("int __stdcall CreateProcessW(str16 application, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32_t flags, void *environment, str16 directory, void *startup, void *information)");
  const resumeThread = kernel.func("uint32_t __stdcall ResumeThread(void *thread)");
  const terminateProcess = kernel.func("int __stdcall TerminateProcess(void *process, uint32_t code)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const failure = (stage: string) => Object.assign(new Error(`Windows suspended process ${stage} failed (Win32 ${String(lastError())}).`), { stage });
  const startup = Buffer.alloc(koffi.sizeof(startupType)), information = Buffer.alloc(koffi.sizeof(informationType));
  startup.writeUInt32LE(startup.length, koffi.offsetof(startupType, "cb"));
  // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW.
  if (create(options.file, Buffer.from(`${command}\0`, "utf16le"), null, null, 0, 0x08000404, environment, options.cwd ?? null, startup, information) === 0) throw failure("create");
  let processHandle: unknown = koffi.decode(information, koffi.offsetof(informationType, "hProcess"), "void *");
  let threadHandle: unknown = koffi.decode(information, koffi.offsetof(informationType, "hThread"), "void *");
  const pid = information.readUInt32LE(koffi.offsetof(informationType, "dwProcessId"));
  let resumed = false, exited = false, closeFailure: unknown;
  const hasExited = (): boolean => {
    if (exited) return true;
    if (processHandle === null) throw new Error("The original Windows process handle is unavailable.");
    const status = wait(processHandle, 0) as number;
    if (status === 0) { exited = true; return true; }
    if (status === 258) return false;
    throw failure("wait");
  };
  const release = () => {
    if (closeFailure !== undefined) throw closeFailure;
    const failures: unknown[] = [];
    if (threadHandle !== null) { if (closeHandle(threadHandle) === 0) failures.push(failure("close-thread")); else threadHandle = null; }
    if (processHandle !== null) { if (closeHandle(processHandle) === 0) failures.push(failure("close-process")); else processHandle = null; }
    if (failures.length) {
      closeFailure = new AggregateError(failures, "Original Windows process handle closure is unconfirmed; handle reuse is forbidden.");
      throw closeFailure;
    }
  };
  return {
    pid, hasExited,
    resume: () => {
      if (resumed || threadHandle === null || hasExited()) throw new Error("The original Windows suspended thread cannot be resumed again.");
      const previous = resumeThread(threadHandle) as number;
      if (previous === 0xffff_ffff) throw failure("resume");
      resumed = true;
      if (previous !== 1) throw new Error("The original Windows thread suspension count changed.");
    },
    terminate: () => {
      if (hasExited()) return;
      if (terminateProcess(processHandle, 1) === 0) throw failure("terminate");
    },
    close: () => {
      if (!hasExited()) throw new Error("The original Windows process has not exited; its handles remain owned.");
      release();
    },
  };
};
