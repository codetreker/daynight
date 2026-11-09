import { performance } from "node:perf_hooks";

type ProcessRow = { pid: number; parentPid: number };
type ProcessIdentity = ProcessRow & { birth: bigint };
export type WindowsProcessStopKernel = {
  open(pid: number): unknown;
  identity(handle: unknown): ProcessIdentity;
  snapshot(checkDeadline: () => void): ProcessRow[];
  signaled(handle: unknown): boolean;
  close(handle: unknown): void;
};
type Member = ProcessIdentity & { handle: unknown };
type DiagnosticIdentity = ProcessRow & { birth: string };
const diagnosticIdentity = ({ pid, parentPid, birth }: ProcessIdentity): DiagnosticIdentity => ({ pid, parentPid, birth: birth.toString() });
let kernel: Promise<WindowsProcessStopKernel> | undefined;

const loadKernel = async (): Promise<WindowsProcessStopKernel> => {
  const koffi = await import("koffi");
  const library = koffi.load("kernel32.dll"), nt = koffi.load("ntdll.dll");
  const open = library.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const times = library.func("int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)");
  const wait = library.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const close = library.func("int __stdcall CloseHandle(void *handle)");
  const lastError = library.func("uint32_t __stdcall GetLastError()");
  const snapshot = library.func("void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)");
  const first = library.func("int __stdcall Process32FirstW(void *snapshot, void *entry)");
  const next = library.func("int __stdcall Process32NextW(void *snapshot, void *entry)");
  const query = nt.func("int32_t __stdcall NtQueryInformationProcess(void *process, uint32_t kind, void *data, uint32_t size, void *returned)");
  const pointerSize = koffi.sizeof("uintptr_t");
  if (pointerSize !== 4 && pointerSize !== 8) throw new Error("Unsupported Windows process pointer size.");
  const pointer = (data: Buffer, offset: number): bigint => pointerSize === 8 ? data.readBigUInt64LE(offset) : BigInt(data.readUInt32LE(offset));
  const failure = (stage: string) => new Error(`Windows review process ${stage} failed (Win32 ${lastError()}).`);
  const closeHandle = (handle: unknown): void => { if (close(handle) === 0) throw failure("CloseHandle"); };
  return {
    open: pid => {
      const handle: unknown = open(0x00101000, 0, pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
      if (handle === null) {
        const code = lastError() as number;
        // libuv likewise maps OpenProcess ERROR_INVALID_PARAMETER to ESRCH.
        // https://github.com/libuv/libuv/blob/5152db2cbfeb5582e9c27c5ea1dba2cd9e10759b/src/win/process.c
        if (code === 87) return null;
        throw new Error(`Windows review process OpenProcess failed (Win32 ${code}).`);
      }
      return handle;
    },
    identity: handle => {
      const creation = Buffer.alloc(8), basic = Buffer.alloc(pointerSize * 6), returned = Buffer.alloc(4);
      if (times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) throw failure("GetProcessTimes");
      const status = query(handle, 0, basic, basic.length, returned) as number;
      if (status < 0) throw new Error(`Windows review process identity failed (NTSTATUS 0x${(status >>> 0).toString(16)}).`);
      const pid = pointer(basic, pointerSize * 4), parentPid = pointer(basic, pointerSize * 5), birth = creation.readBigUInt64LE();
      if (returned.readUInt32LE() !== basic.length || pid <= 0n || pid > 0xffff_ffffn || parentPid > 0xffff_ffffn || birth <= 0n) throw new Error("Invalid Windows review process identity.");
      return { pid: Number(pid), parentPid: Number(parentPid), birth };
    },
    snapshot: checkDeadline => {
      const handle: unknown = snapshot(2, 0); // TH32CS_SNAPPROCESS
      if (handle === null || koffi.address(handle) === (1n << BigInt(pointerSize * 8)) - 1n) throw failure("CreateToolhelp32Snapshot");
      const rows: ProcessRow[] = [], failures: unknown[] = [];
      try {
        // PROCESSENTRY32W includes an aligned ULONG_PTR before its parent PID.
        const entry = Buffer.alloc(pointerSize === 8 ? 568 : 556);
        entry.writeUInt32LE(entry.length);
        let available = first(handle, entry) as number;
        while (available !== 0) {
          checkDeadline();
          rows.push({ pid: entry.readUInt32LE(8), parentPid: entry.readUInt32LE(pointerSize === 8 ? 32 : 24) });
          available = next(handle, entry) as number;
        }
        if (lastError() !== 18) throw failure("Process32NextW"); // ERROR_NO_MORE_FILES
      } catch (error) { failures.push(error); }
      try { closeHandle(handle); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Windows review process inventory failed.");
      return rows;
    },
    signaled: handle => {
      const result = wait(handle, 0) as number;
      if (result === 0) return true;
      if (result === 258) return false;
      throw failure("WaitForSingleObject");
    },
    close: closeHandle,
  };
};

/** Retain the pre-termination inventory's process objects until they signal.
 * taskkill /T still owns descendant termination; a snapshot does not contain
 * descendants born later or recover ancestry through an already exited parent.
 */
export const stopWindowsProcessTree = async (options: {
  pid: number;
  graceMs: number;
  assertCurrent: () => void;
  terminate: () => Promise<void>;
}, suppliedKernel?: WindowsProcessStopKernel): Promise<void> => {
  const captureDeadline = performance.now() + options.graceMs;
  const checkDeadline = (): void => {
    if (performance.now() >= captureDeadline) throw new Error("Windows review process inventory exceeded its deadline.");
  };
  const api = suppliedKernel ?? await (kernel ??= loadKernel());
  checkDeadline();
  options.assertCurrent();
  const members: Member[] = [], handles: unknown[] = [], failures: unknown[] = [];
  const ancestry: Array<{ reason: "parent-unproven" | "parent-changed" | "child-predates-parent";
    snapshot: ProcessRow; member: DiagnosticIdentity; parent: DiagnosticIdentity | null; signaled: false }> = [];
  let ancestryFailures = 0;
  const capture = (pid: number): Member | null => {
    checkDeadline();
    const handle = api.open(pid);
    if (handle === null) return null;
    handles.push(handle);
    const identity = api.identity(handle);
    if (identity.pid !== pid) throw new Error("Windows review process identity changed during inventory.");
    return { ...identity, handle };
  };
  const rootLive = (root: Member): void => {
    options.assertCurrent();
    if (api.signaled(root.handle)) throw new Error("The Windows review root exited before tree termination.");
  };
  try {
    const root = capture(options.pid);
    if (root === null) throw new Error("The Windows review root no longer exists.");
    members.push(root);
    if (root.parentPid !== process.pid) throw new Error("The Windows review root is not a child of this CLI.");
    rootLive(root);
    try {
      const rows = api.snapshot(checkDeadline), children = new Map<number, ProcessRow[]>(), seen = new Set<number>();
      for (const row of rows) {
        checkDeadline();
        if (seen.has(row.pid)) throw new Error("Duplicate process in Windows review inventory.");
        seen.add(row.pid);
        const siblings = children.get(row.parentPid) ?? [];
        siblings.push(row); children.set(row.parentPid, siblings);
      }
      if (!seen.has(root.pid)) throw new Error("The Windows review root is absent from its process inventory.");
      const queue: Array<{ pid: number; member: Member | null }> = [{ pid: root.pid, member: root }];
      const visited = new Set([root.pid]);
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index]!;
        for (const row of children.get(parent.pid) ?? []) {
          checkDeadline();
          if (visited.has(row.pid)) throw new Error("Cyclic Windows review process inventory.");
          visited.add(row.pid);
          let accepted: Member | null = null;
          try {
            const member = capture(row.pid);
            if (member !== null) {
              if (parent.member !== null && member.parentPid === parent.pid && member.birth >= parent.member.birth) {
                accepted = member; members.push(member);
              } else if (!api.signaled(member.handle)) {
                ancestryFailures++;
                if (ancestry.length < 8) ancestry.push({
                  reason: parent.member === null ? "parent-unproven" : member.parentPid !== parent.pid ? "parent-changed" : "child-predates-parent",
                  snapshot: { pid: row.pid, parentPid: row.parentPid }, member: diagnosticIdentity(member),
                  parent: parent.member === null ? null : diagnosticIdentity(parent.member), signaled: false,
                });
              }
            }
          } catch (error) { failures.push(error); }
          // Traverse missing intermediates too: a vanished branch is harmless,
          // but surviving descendants across an unproven parent remain unsafe.
          queue.push({ pid: row.pid, member: accepted });
        }
      }
      checkDeadline();
    } catch (error) { failures.push(error); }
    if (ancestryFailures > 0) failures.push(new Error("A live Windows review descendant cannot be attributed through its original parent.\nWindows review ancestry: " +
      JSON.stringify({ schemaVersion: 1, root: diagnosticIdentity(root), liveRejected: ancestryFailures,
        omitted: ancestryFailures - ancestry.length, candidates: ancestry })));
    // A held root object pins the taskkill PID. Recheck it after inventory,
    // including failed inventory, before retaining the existing /T behavior.
    rootLive(root);
    try { await options.terminate(); } catch (error) { failures.push(error); }
    const waitDeadline = performance.now() + options.graceMs;
    let pending = members;
    while (pending.length) {
      pending = pending.filter(member => !api.signaled(member.handle));
      if (pending.length === 0) break;
      if (performance.now() >= waitDeadline) throw new Error("Windows review processes did not signal exit within the termination grace period.");
      await new Promise<void>(resolve => { setTimeout(resolve, Math.min(25, options.graceMs)); });
    }
  } catch (error) { failures.push(error); }
  for (const handle of handles) {
    try { api.close(handle); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Cannot confirm Windows review process termination.");
};
