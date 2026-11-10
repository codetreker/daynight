import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PrivateOperationFiles } from "./private-files.js";

type Handle = unknown;
// Native handles retain directory identity and deny rename while records are used.
export const loadWindowsOperationFiles = async (): Promise<PrivateOperationFiles> => {
  const koffi = await import("koffi");
  const kernel = koffi.load("kernel32.dll"), advapi = koffi.load("advapi32.dll"), nt = koffi.load("ntdll.dll");
  const ptr = koffi.sizeof("uintptr_t");
  if (ptr !== 4 && ptr !== 8) throw new Error("Unsupported Windows pointer size.");
  const pointer = (buffer: Buffer, offset = 0): unknown => koffi.decode(buffer.subarray(offset, offset + ptr), "void *");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const free = kernel.func("void * __stdcall LocalFree(void *memory)");
  const currentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
  const openToken = advapi.func("int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)");
  const tokenInformation = advapi.func("int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, void *returned)");
  const sidString = advapi.func("int __stdcall ConvertSidToStringSidW(void *sid, void *result)");
  const descriptor = advapi.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, void *result, void *size)");
  const security = advapi.func("uint32_t __stdcall GetSecurityInfo(void *handle, int type, uint32_t information, void *owner, void *group, void *dacl, void *sacl, void *descriptor)");
  const control = advapi.func("int __stdcall GetSecurityDescriptorControl(void *descriptor, void *control, void *revision)");
  const equalSid = advapi.func("int __stdcall EqualSid(void *a, void *b)");
  const getAce = advapi.func("int __stdcall GetAce(void *acl, uint32_t index, void *ace)");
  const aclInformation = advapi.func("int __stdcall GetAclInformation(void *acl, void *information, uint32_t size, int kind)");
  const attributes = koffi.struct({ nLength: "uint32_t", lpSecurityDescriptor: "void *", bInheritHandle: "int" });
  const createDirectory = kernel.func("int __stdcall CreateDirectoryW(str16 path, void *attributes)");
  const createFile = kernel.func("void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *attributes, uint32_t creation, uint32_t flags, void *template)");
  const fileInformation = kernel.func("int __stdcall GetFileInformationByHandle(void *handle, void *information)");
  const volumeInformation = kernel.func("int __stdcall GetVolumeInformationByHandleW(void *handle, void *name, uint32_t nameSize, void *serial, void *componentLength, void *flags, void *filesystem, uint32_t filesystemSize)");
  const readFile = kernel.func("int __stdcall ReadFile(void *file, void *buffer, uint32_t count, void *read, void *overlapped)");
  const writeFile = kernel.func("int __stdcall WriteFile(void *file, void *buffer, uint32_t count, void *written, void *overlapped)");
  const flushFile = kernel.func("int __stdcall FlushFileBuffers(void *file)");
  const flushDirectory = nt.func("int32_t __stdcall NtFlushBuffersFileEx(void *file, uint32_t flags, void *parameters, uint32_t size, void *status)");
  const moveFile = kernel.func("int __stdcall MoveFileExW(str16 from, str16 to, uint32_t flags)");
  const deleteFile = kernel.func("int __stdcall DeleteFileW(str16 path)");
  const failure = (stage: string): Error & { readonly stage: string; readonly win32Code: number } => {
    const win32Code = lastError() as number;
    return Object.assign(new Error(`Private operation storage ${stage} failed (Win32 ${win32Code}).`), { stage, win32Code });
  };
  const closeHandle = (handle: Handle): void => { if (!close(handle)) throw failure("close"); };
  const withHandle = <T>(handle: Handle, action: () => T): T => {
    let failed = false, primary: unknown;
    try { return action(); }
    catch (error) { failed = true; primary = error; throw error; }
    finally {
      try { closeHandle(handle); }
      catch (cleanup) { throw failed ? new AggregateError([primary, cleanup], "Operation storage and handle cleanup failed.", { cause: primary }) : cleanup; }
    }
  };
  const badHandle = (handle: Handle): boolean => handle === null || (typeof handle === "bigint" && BigInt.asIntN(ptr * 8, handle) === -1n);
  const tokenOut = Buffer.alloc(ptr);
  if (!openToken(currentProcess(), 8, tokenOut)) throw failure("open-token");
  const token = pointer(tokenOut), returned = Buffer.alloc(4);
  // Retain TokenUser storage: its SID is an interior pointer into this buffer.
  const tokenUser = Buffer.alloc(65_536);
  const sidText = withHandle(token, () => {
    if (!tokenInformation(token, 1, tokenUser, tokenUser.length, returned)) throw failure("token-user");
    const sid = pointer(tokenUser);
    const textOut = Buffer.alloc(ptr);
    if (!sidString(sid, textOut)) throw failure("sid-string");
    const text = pointer(textOut);
    try { return koffi.decode.string16(text); } finally { free(text); }
  });
  const securityOut = Buffer.alloc(ptr);
  if (!descriptor(`O:${sidText}D:P(A;;FA;;;${sidText})`, 1, securityOut, null)) throw failure("security-descriptor");
  const allocatedDescriptor = pointer(securityOut);
  const descriptorLength = advapi.func("uint32_t __stdcall GetSecurityDescriptorLength(void *descriptor)");
  const sd = Buffer.from(koffi.decode(allocatedDescriptor, "uint8_t", descriptorLength(allocatedDescriptor) as number) as number[]);
  free(allocatedDescriptor);
  const securityAttributes = Buffer.alloc(koffi.sizeof(attributes));
  koffi.encode(securityAttributes, attributes, { nLength: securityAttributes.length, lpSecurityDescriptor: sd, bInheritHandle: 0 });
  const verify = (handle: Handle, directory: boolean, privateObject: boolean): void => {
    const information = Buffer.alloc(52);
    if (!fileInformation(handle, information)) throw failure("file-information");
    const flags = information.readUInt32LE(0);
    if ((flags & 0x400) !== 0 || ((flags & 0x10) !== 0) !== directory || !directory && information.readUInt32LE(40) !== 1) throw new Error("Operation storage refuses reparse points, nonregular objects and hard links.");
    const volumeFlags = Buffer.alloc(4);
    if (!volumeInformation(handle, null, 0, null, null, volumeFlags, null, 0)) throw failure("volume-information");
    if ((volumeFlags.readUInt32LE() & 8) === 0) throw new Error("Operation storage requires persistent filesystem ACLs.");
    if (!privateObject) return;
    const ownerOut = Buffer.alloc(ptr), daclOut = Buffer.alloc(ptr), actualOut = Buffer.alloc(ptr);
    const result = security(handle, 1, 5, ownerOut, null, daclOut, null, actualOut) as number;
    if (result !== 0) throw new Error(`Private operation ACL read failed (Win32 ${result}).`);
    const actual = pointer(actualOut), dacl = pointer(daclOut);
    try {
      const flags = Buffer.alloc(2), revision = Buffer.alloc(4), acl = Buffer.alloc(12), aceOut = Buffer.alloc(ptr);
      if (!control(actual, flags, revision)) throw failure("descriptor-control");
      if (!equalSid(pointer(ownerOut), pointer(tokenUser)) || dacl === null || (flags.readUInt16LE() & 0x1004) !== 0x1004) throw new Error("Operation storage requires an owned protected DACL.");
      if (!aclInformation(dacl, acl, acl.length, 2)) throw failure("acl-information");
      if (acl.readUInt32LE() !== 1 || !getAce(dacl, 0, aceOut)) throw new Error("Operation storage requires exactly one current-user allow ACE.");
      const ace = pointer(aceOut), header = Buffer.from(koffi.decode(ace, "uint8_t", 8) as number[]);
      if (header[0] !== 0 || header[1] !== 0 || header.readUInt32LE(4) !== 0x001f01ff || !equalSid(koffi.address(ace) + 8n, pointer(tokenUser))) throw new Error("Operation storage ACL grants unexpected access.");
    } finally { free(actual); }
  };
  const openHandle = (name: string, directory: boolean, create: boolean, exclusive = false, writable = true): Handle => {
    if (create) koffi.encode(securityAttributes, attributes, { nLength: securityAttributes.length, lpSecurityDescriptor: sd, bInheritHandle: 0 });
    // Unlike node:fs, direct Win32 calls need an explicit extended-length path.
    const handle: unknown = createFile(path.toNamespacedPath(name), writable ? 0xc0020000 : 0x80020000, exclusive ? 0 : 3, create ? securityAttributes : null, create ? 1 : 3, 0x00200000 | (directory ? 0x02000000 : 0) | 0x80000000, null);
    if (badHandle(handle)) throw failure("open");
    return handle;
  };
  const flush = (handle: Handle): void => {
    const iosb = Buffer.alloc(ptr * 2);
    const status = flushDirectory(handle, 0, null, 0, iosb) as number;
    // Synchronous handles must complete both the call and IO_STATUS_BLOCK.
    if (status !== 0 || iosb.readInt32LE() !== 0) throw new Error(`Operation directory flush failed (NTSTATUS 0x${(status >>> 0).toString(16)}).`);
  };
  return {
    open: async (directory, create) => {
      const actor = directory, origin = path.dirname(actor), managed = path.dirname(origin), root = path.dirname(managed);
      const handles: Handle[] = [];
      const dispose = async (): Promise<void> => { const failures: unknown[] = []; for (const handle of handles.reverse()) { try { closeHandle(handle); } catch (error) { failures.push(error); } } handles.length = 0; if (failures.length) throw new AggregateError(failures, "Recovery directory close failed."); };
      try {
        // Hold every ancestor without DELETE sharing to prevent junction substitution.
        const parsed = path.parse(root); let ancestor = parsed.root;
        for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
          ancestor = path.join(ancestor, part);
          const handle = openHandle(ancestor, true, false, false, ancestor === root); handles.push(handle); verify(handle, true, false);
        }
        for (const target of [managed, origin, actor]) {
          if (create && !createDirectory(path.toNamespacedPath(target), securityAttributes) && lastError() !== 183) throw failure("mkdir");
          let handle: Handle;
          try { handle = openHandle(target, true, false); }
          catch (error) { const code = (error as { win32Code?: number }).win32Code; if (!create && (code === 2 || code === 3)) { await dispose(); return undefined; } throw error; }
          handles.push(handle); verify(handle, true, true);
          if (create) { flush(handle); flush(handles[handles.length - 2]); }
        }
        const parent = handles.at(-1);
        return {
          close: dispose,
          read: async name => {
            let handle: Handle;
            try { handle = openHandle(path.join(directory, name), false, false); }
            catch (error) { if ((error as { win32Code?: number }).win32Code === 2) return undefined; throw error; }
            return withHandle(handle, () => {
              verify(handle, false, true);
              const bytes = Buffer.alloc(32_769), read = Buffer.alloc(4);
              if (!readFile(handle, bytes, bytes.length, read, null)) throw failure("read");
              const size = read.readUInt32LE(); if (size > 32_768) throw new Error("Operation record exceeds its limit.");
              return bytes.subarray(0, size);
            });
          },
          lock: async name => {
            let handle: Handle;
            try { handle = openHandle(path.join(directory, name), false, true, true); }
            catch (error) { if (![80, 183].includes((error as { win32Code?: number }).win32Code ?? 0)) throw error; handle = openHandle(path.join(directory, name), false, false, true); }
            try { verify(handle, false, true); return async () => { closeHandle(handle); }; }
            catch (error) { return withHandle(handle, () => { throw error; }); }
          },
          replace: async (name, bytes) => {
            const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`), target = path.join(directory, name);
            let created = false, published = false, failed = false, primary: unknown;
            try {
              const handle = openHandle(temporary, false, true);
              created = true;
              withHandle(handle, () => {
                verify(handle, false, true);
                const written = Buffer.alloc(4);
                if (!writeFile(handle, bytes, bytes.length, written, null) || written.readUInt32LE() !== bytes.length) throw failure("write");
                if (!flushFile(handle)) throw failure("file-flush");
              });
              let previous: Handle | undefined;
              try { previous = openHandle(target, false, false); }
              catch (error) { if ((error as { win32Code?: number }).win32Code !== 2) throw error; }
              if (previous !== undefined) withHandle(previous, () => verify(previous, false, true));
              if (!moveFile(path.toNamespacedPath(temporary), path.toNamespacedPath(target), 1 | 8)) throw failure("rename-write-through");
              published = true; flush(parent);
              const final = openHandle(target, false, false); withHandle(final, () => verify(final, false, true));
            } catch (error) { failed = true; primary = error; throw error; }
            finally {
              // CREATE_NEW must have succeeded before this invocation owns the temporary file.
              if (created && !published && !deleteFile(path.toNamespacedPath(temporary))) {
                const cleanup = failure("temporary-cleanup");
                if (cleanup.win32Code !== 2) throw failed ? new AggregateError([primary, cleanup], "Operation storage and temporary cleanup failed.", { cause: primary }) : cleanup;
              }
            }
          },
        };
      } catch (error) {
        try { await dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Operation storage and directory cleanup failed.", { cause: error }); }
        throw error;
      }
    },
  };
};
