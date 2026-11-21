import path from "node:path";

/** A process whose working directory keeps a managed directory open.
 *
 * `handle` stays open for the lifetime of the inventory. Windows does not
 * recycle a process identifier while any handle to that process remains open,
 * so holding it is what makes the identifier safe to pass to a terminator:
 * comparing `birth` afterwards would still leave a window in which the
 * identifier had already been reused.
 */
export type WindowsDirectoryHolder = { readonly pid: number; readonly birth: bigint; readonly image: string; readonly directory: string; readonly handle: unknown };
export type WindowsDirectoryInventory = { readonly holders: readonly WindowsDirectoryHolder[]; readonly release: () => void };

export type WindowsDirectoryHolderKernel = {
  /** Every process identifier currently known to the system, with the parent
   * Windows records for it. The parent is what lets the inventory recognize
   * this process's own ancestors. */
  processes(check: () => void): readonly { readonly pid: number; readonly image: string; readonly parent: number }[];
  /** Open one process and read its working directory and creation time, or
   * return null when it cannot be opened or read. An unreadable process is not
   * an error: another account's process is not a holder this Worker can act on.
   * A returned handle belongs to the caller until it is closed.
   */
  inspect(pid: number): { readonly birth: bigint; readonly directory: string; readonly handle: unknown } | null;
  close(handle: unknown): void;
};

let kernel: Promise<WindowsDirectoryHolderKernel> | undefined;

// Offsets into the PEB and RTL_USER_PROCESS_PARAMETERS. A wrong offset reads
// an unrelated address and could report a directory that belongs to no
// process, so an unexpected pointer size is refused rather than guessed and
// each inspected process is read through the layout its own code uses.
// UNICODE_STRING is { USHORT Length; USHORT MaximumLength; PWSTR Buffer }, so
// the 64-bit form pads before its pointer and the 32-bit form does not.
const nativeLayout = { parameters: 0x20n, directory: 0x38n, pointer: 8, stringBytes: 16, stringBuffer: 8 } as const;
// A WOW64 process runs 32-bit code that maintains its 32-bit process
// parameters. The native structures reached through ProcessBasicInformation do
// not carry that process's active working directory, so reading them would
// silently omit a 32-bit holder.
const wow64Layout = { parameters: 0x10n, directory: 0x24n, pointer: 4, stringBytes: 8, stringBuffer: 4 } as const;
const processEntrySize = 568;
const processEntryIdOffset = 8;
const processEntryParentOffset = 32;
const processEntryImageOffset = 44;
const processEntryImageBytes = 520;

const loadKernel = async (): Promise<WindowsDirectoryHolderKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("kernel32.dll"), nt = koffi.load("ntdll.dll");
  const open = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const times = library.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const readMemory = library.func("int __stdcall ReadProcessMemory(void *process, uint64_t address, void *buffer, uint64_t size, void *read)");
  const snapshot = library.func("void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)");
  const first = library.func("int __stdcall Process32FirstW(void *snapshot, void *entry)");
  const next = library.func("int __stdcall Process32NextW(void *snapshot, void *entry)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const query = nt.func("int32_t __stdcall NtQueryInformationProcess(void *process, uint32_t kind, void *data, uint32_t size, void *returned)");
  const pointerSize = koffi.sizeof("uintptr_t");
  if (pointerSize !== 8) throw new Error("Windows directory holder inventory requires a 64-bit process.");
  const failure = (stage: string): Error => new Error(`Windows directory holder ${stage} failed (Win32 ${lastError()}).`);
  const closeHandle = (handle: unknown): void => { if (close(handle) === 0) throw failure("CloseHandle"); };
  const read = (handle: unknown, address: bigint, size: number): Buffer | null => {
    const buffer = Buffer.alloc(size), transferred = Buffer.alloc(8);
    if (readMemory(handle, address, buffer, BigInt(size), transferred) === 0) return null;
    return transferred.readBigUInt64LE() === BigInt(size) ? buffer : null;
  };
  return {
    processes: check => {
      const handle: unknown = snapshot(2, 0); // TH32CS_SNAPPROCESS
      if (handle === null || koffi.address(handle) === (1n << 64n) - 1n) throw failure("CreateToolhelp32Snapshot");
      const rows: { pid: number; image: string; parent: number }[] = [], failures: unknown[] = [];
      try {
        const entry = Buffer.alloc(processEntrySize);
        entry.writeUInt32LE(entry.length);
        let available = first(handle, entry) as number;
        while (available !== 0) {
          check();
          rows.push({ pid: entry.readUInt32LE(processEntryIdOffset), parent: entry.readUInt32LE(processEntryParentOffset),
            image: entry.subarray(processEntryImageOffset, processEntryImageOffset + processEntryImageBytes).toString("ucs2").replace(/\0.*$/s, "") });
          available = next(handle, entry) as number;
        }
        if (lastError() !== 18) throw failure("Process32NextW"); // ERROR_NO_MORE_FILES
      } catch (error) { failures.push(error); }
      try { closeHandle(handle); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Windows directory holder inventory failed.");
      return rows;
    },
    inspect: pid => {
      // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. Another account's process
      // refuses both, which is why an absent result is not a failure.
      const handle: unknown = open(0x0410, 0, pid);
      if (handle === null) return null;
      let keep = false;
      try {
        const creation = Buffer.alloc(8);
        if (times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) return null;
        const birth = creation.readBigUInt64LE();
        if (birth <= 0n) return null;
        // ProcessWow64Information yields the 32-bit PEB of a WOW64 process and
        // zero for a native one, which is what selects the layout below.
        const wow64 = Buffer.alloc(8), wow64Returned = Buffer.alloc(4);
        if ((query(handle, 26, wow64, wow64.length, wow64Returned) as number) < 0 || wow64Returned.readUInt32LE() !== wow64.length) return null;
        const wow64Peb = wow64.readBigUInt64LE();
        const layout = wow64Peb === 0n ? nativeLayout : wow64Layout;
        let peb = wow64Peb;
        if (peb === 0n) {
          const basic = Buffer.alloc(8 * 6), returned = Buffer.alloc(4);
          if ((query(handle, 0, basic, basic.length, returned) as number) < 0 || returned.readUInt32LE() !== basic.length) return null;
          peb = basic.readBigUInt64LE(8);
        }
        if (peb === 0n) return null;
        const pointerAt = (data: Buffer, offset = 0): bigint => layout.pointer === 8 ? data.readBigUInt64LE(offset) : BigInt(data.readUInt32LE(offset));
        const parametersValue = read(handle, peb + layout.parameters, layout.pointer);
        if (parametersValue === null) return null;
        const parameters = pointerAt(parametersValue);
        if (parameters === 0n) return null;
        const directoryString = read(handle, parameters + layout.directory, layout.stringBytes);
        if (directoryString === null) return null;
        const length = directoryString.readUInt16LE(0), buffer = pointerAt(directoryString, layout.stringBuffer);
        // A process between creation and its first directory assignment has an
        // empty string; an implausible length means the layout did not match.
        if (length === 0 || length % 2 !== 0 || length > 0x8000 || buffer === 0n) return null;
        const text = read(handle, buffer, length);
        if (text === null) return null;
        keep = true;
        return { birth, directory: text.toString("ucs2"), handle };
      } finally { if (!keep) closeHandle(handle); }
    },
    close: closeHandle,
  };
};

/** The kernel this machine's inventory reads through.
 *
 * Exported for tests that check the structure layout against the running
 * system. An injected kernel proves the matching and the ancestor walk; only
 * the real one can prove that these offsets describe what Windows stores, and
 * a wrong offset fails silently — the walk would simply find nothing.
 */
export const windowsDirectoryHolderKernel = async (): Promise<WindowsDirectoryHolderKernel> => await (kernel ??= loadKernel());

const normalized = (value: string): string => {
  const resolved = path.win32.resolve(value);
  return (resolved.endsWith(path.win32.sep) ? resolved.slice(0, -path.win32.sep.length) : resolved).toLowerCase();
};

/** Processes whose working directory is `root` or one of its descendants.
 *
 * Windows keeps a directory handle open for every process working directory,
 * so such a process makes `root` undeletable while it lives. The match is on
 * the normalized path: this inventory reports a holder, it does not resolve
 * links or prove that the caller owns `root`.
 *
 * This process and its ancestors are never reported. A terminator reaches the
 * descendants of what it is given, so either one would end this process.
 *
 * The caller must call `release` once it has finished acting on the result.
 */
export const windowsDirectoryHolders = async (
  root: string,
  check: () => void,
  suppliedKernel?: WindowsDirectoryHolderKernel,
): Promise<WindowsDirectoryInventory> => {
  if (process.platform !== "win32" && suppliedKernel === undefined) throw new Error("Windows directory holders are only available on Windows.");
  const api = suppliedKernel ?? await windowsDirectoryHolderKernel();
  const prefix = normalized(root), boundary = `${prefix}${path.win32.sep}`;
  const holders: WindowsDirectoryHolder[] = [];
  const release = (): void => {
    const failures: unknown[] = [];
    for (const holder of holders.splice(0)) {
      try { api.close(holder.handle); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Windows directory holder release failed.");
  };
  try {
    check();
    const rows = api.processes(check);
    // A terminator ends the holder's descendants as well, so this process's own
    // ancestors are not holders it may act on: ending one would end this
    // cleanup partway through a removal, with no error left to report and the
    // worktree in whatever state it had reached. Excluding only this process
    // would leave that reachable through any ancestor holding the tree, which
    // a Worker started from a shell inside the worktree would have.
    //
    // Windows reuses a parent identifier once that parent has exited, so the
    // walk can stop early or follow a stale link. Either way it only declines a
    // termination, which is the safe direction to be wrong in.
    const parents = new Map(rows.map(row => [row.pid, row.parent]));
    const protectedProcesses = new Set<number>([0, process.pid]);
    for (let current = parents.get(process.pid); current !== undefined && !protectedProcesses.has(current); current = parents.get(current)) protectedProcesses.add(current);
    for (const { pid, image } of rows) {
      check();
      if (protectedProcesses.has(pid)) continue;
      const observed = api.inspect(pid);
      if (observed === null) continue;
      const directory = normalized(observed.directory);
      if (directory !== prefix && !directory.startsWith(boundary)) { api.close(observed.handle); continue; }
      holders.push({ pid, birth: observed.birth, image, directory: observed.directory, handle: observed.handle });
    }
  } catch (error) {
    try { release(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Windows directory holder inventory and release failed.", { cause: error }); }
    throw error;
  }
  return { holders: [...holders], release };
};
