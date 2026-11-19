import assert from "node:assert/strict";
import path from "node:path";

type Pointer = unknown;
export type WindowsAclNative = {
  pointerSize: number;
  pointer: (buffer: Buffer) => Pointer;
  bytes: (pointer: Pointer, length: number) => Buffer;
  offset: (pointer: Pointer, offset: number) => Pointer;
  lastError: () => number;
  currentProcess: () => Pointer;
  openToken: (process: Pointer, access: number, output: Buffer) => number;
  tokenInformation: (token: Pointer, kind: number, output: Buffer | null, length: number, returned: Buffer) => number;
  openFile: (name: string, access: number, share: number, attributes: null, creation: number, flags: number, template: null) => Pointer;
  security: (file: Pointer, type: number, information: number, owner: Buffer, group: null, dacl: Buffer, sacl: null, descriptor: Buffer) => number;
  control: (descriptor: Pointer, flags: Buffer, revision: Buffer) => number;
  aclInformation: (dacl: Pointer, output: Buffer, length: number, kind: number) => number;
  getAce: (dacl: Pointer, index: number, output: Buffer) => number;
  equalSid: (a: Pointer, b: Pointer) => number;
  close: (handle: Pointer) => number;
  free: (memory: Pointer) => Pointer;
};

const loadNative = async (): Promise<WindowsAclNative> => {
  const koffi = await import("koffi");
  const kernel = koffi.load("kernel32.dll"), advapi = koffi.load("advapi32.dll");
  const pointerSize = koffi.sizeof("uintptr_t");
  return {
    pointerSize,
    pointer: buffer => koffi.decode(buffer, "void *"),
    bytes: (pointer, length) => Buffer.from(koffi.decode(pointer, "uint8_t", length) as number[]),
    offset: (pointer, offset) => koffi.address(pointer) + BigInt(offset),
    lastError: kernel.func("uint32_t __stdcall GetLastError()"),
    currentProcess: kernel.func("void * __stdcall GetCurrentProcess()"),
    openToken: advapi.func("int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)"),
    tokenInformation: advapi.func("int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, void *returned)"),
    openFile: kernel.func("void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *attributes, uint32_t creation, uint32_t flags, void *template)"),
    security: advapi.func("uint32_t __stdcall GetSecurityInfo(void *handle, int type, uint32_t information, void *owner, void *group, void *dacl, void *sacl, void *descriptor)"),
    control: advapi.func("int __stdcall GetSecurityDescriptorControl(void *descriptor, void *control, void *revision)"),
    aclInformation: advapi.func("int __stdcall GetAclInformation(void *acl, void *information, uint32_t size, int kind)"),
    getAce: advapi.func("int __stdcall GetAce(void *acl, uint32_t index, void *ace)"),
    equalSid: advapi.func("int __stdcall EqualSid(void *a, void *b)"),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    free: kernel.func("void * __stdcall LocalFree(void *memory)"),
  };
};

// The observer owns its Win32 declarations and assertions independently of the store.
export const assertPrivateWindowsAcl = async (target: string, injectedNative?: WindowsAclNative): Promise<void> => {
  const native = injectedNative ?? await loadNative();
  assert.ok(native.pointerSize === 4 || native.pointerSize === 8, "Unsupported Windows pointer size.");
  const failure = (stage: string, win32Code = native.lastError()) => Object.assign(
    new Error(`Windows ACL observer ${stage} failed (Win32 ${win32Code}).`), { stage, win32Code },
  );
  const cleanups: (() => void)[] = [];
  const retainHandle = (handle: Pointer, stage: string) => {
    cleanups.push(() => { if (!native.close(handle)) throw failure(stage); });
  };
  let failed = false, primary: unknown;
  try {
    const tokenOut = Buffer.alloc(native.pointerSize);
    if (!native.openToken(native.currentProcess(), 8, tokenOut)) throw failure("open-token");
    const token = native.pointer(tokenOut);
    retainHandle(token, "close-token");
    const required = Buffer.alloc(4);
    if (native.tokenInformation(token, 1, null, 0, required)) throw new Error("Windows ACL observer expected a TokenUser size query.");
    const sizeError = native.lastError();
    if (sizeError !== 122) throw failure("token-user-size", sizeError);
    // TOKEN_USER contains a SID pointer into this buffer, retained through the comparisons.
    const tokenUser = Buffer.alloc(required.readUInt32LE());
    if (!native.tokenInformation(token, 1, tokenUser, tokenUser.length, required)) throw failure("token-user");
    const currentSid = () => native.pointer(tokenUser);

    const file = native.openFile(path.toNamespacedPath(target), 0x00020000, 7, null, 3, 0x02000000, null);
    if (file === null || typeof file === "bigint" && BigInt.asIntN(native.pointerSize * 8, file) === -1n) throw failure("open-file");
    retainHandle(file, "close-file");
    const ownerOut = Buffer.alloc(native.pointerSize), daclOut = Buffer.alloc(native.pointerSize), descriptorOut = Buffer.alloc(native.pointerSize);
    const result = native.security(file, 1, 5, ownerOut, null, daclOut, null, descriptorOut);
    if (result !== 0) throw failure("get-security", result);
    const descriptor = native.pointer(descriptorOut), dacl = native.pointer(daclOut);
    cleanups.push(() => { if (native.free(descriptor) !== null) throw failure("free-descriptor"); });
    const control = Buffer.alloc(2), revision = Buffer.alloc(4);
    if (!native.control(descriptor, control, revision)) throw failure("descriptor-control");
    const owner = native.pointer(ownerOut);
    assert.ok(owner !== null && native.equalSid(owner, currentSid()), "Windows ACL owner must be the current user.");
    assert.notEqual(dacl, null, "Windows ACL must have a non-null DACL.");
    assert.equal(control.readUInt16LE() & 0x1004, 0x1004, "Windows DACL must be present and protected.");

    const information = Buffer.alloc(12);
    if (!native.aclInformation(dacl, information, information.length, 2)) throw failure("acl-information");
    assert.equal(information.readUInt32LE(), 1, "Windows DACL must contain exactly one ACE.");
    const aceOut = Buffer.alloc(native.pointerSize);
    if (!native.getAce(dacl, 0, aceOut)) throw failure("get-ace");
    const ace = native.pointer(aceOut), header = native.bytes(ace, 8);
    assert.equal(header[0], 0, "Windows DACL ACE must allow access.");
    assert.equal(header[1], 0, "Windows DACL ACE must have no inheritance flags.");
    assert.equal(header.readUInt32LE(4), 0x001f01ff, "Windows DACL ACE must grant FullControl.");
    assert.ok(native.equalSid(native.offset(ace, 8), currentSid()), "Windows DACL ACE must name the current user.");
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      if (failed) throw new AggregateError([primary, ...errors], "Windows ACL observation and cleanup failed.", { cause: primary });
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "Windows ACL observer cleanup failed.");
    }
  }
};
