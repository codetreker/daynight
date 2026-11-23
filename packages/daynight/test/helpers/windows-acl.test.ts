import { expect, test, vi } from "vitest";
import { assertPrivateWindowsAcl, type WindowsAclNative } from "./windows-acl.js";

const token = 10n, file = 20n, descriptor = 30n, dacl = 40n, ace = 50n, currentSid = 60n;
const fixture = () => {
  const acl = { owner: currentSid as bigint | null, dacl: dacl as bigint | null, control: 0x1004, count: 1, type: 0, flags: 0, mask: 0x001f01ff, aceSid: currentSid };
  const pointer = (output: Buffer, value: bigint | null) => output.writeBigUInt64LE(value === null ? 0n : value);
  const native: WindowsAclNative = {
    pointerSize: 8,
    pointer: buffer => buffer.readBigUInt64LE() === 0n ? null : buffer.readBigUInt64LE(),
    bytes: (value, length) => {
      expect(value).toBe(ace); expect(length).toBe(8);
      const header = Buffer.alloc(8); header[0] = acl.type; header[1] = acl.flags; header.writeUInt32LE(acl.mask, 4); return header;
    },
    offset: (value, offset) => { expect(value).toBe(ace); expect(offset).toBe(8); return acl.aceSid; },
    lastError: () => 122,
    currentProcess: () => -1n,
    openToken: vi.fn((process, access, output) => { expect(process).toBe(-1n); expect(access).toBe(8); pointer(output, token); return 1; }),
    tokenInformation: vi.fn((handle, kind, output, length, returned) => {
      expect(handle).toBe(token); expect(kind).toBe(1); returned.writeUInt32LE(32);
      if (output === null) { expect(length).toBe(0); return 0; }
      expect(length).toBe(32); pointer(output, currentSid); return 1;
    }),
    openFile: vi.fn(() => file),
    security: vi.fn((handle, type, information, owner, group, outputDacl, sacl, outputDescriptor) => {
      expect(handle).toBe(file); expect(type).toBe(1); expect(information).toBe(5); expect(group).toBeNull(); expect(sacl).toBeNull();
      pointer(owner, acl.owner); pointer(outputDacl, acl.dacl); pointer(outputDescriptor, descriptor); return 0;
    }),
    control: vi.fn((value, flags, revision) => { expect(value).toBe(descriptor); flags.writeUInt16LE(acl.control); revision.writeUInt32LE(1); return 1; }),
    aclInformation: vi.fn((value, output, length, kind) => { expect(value).toBe(dacl); expect(length).toBe(12); expect(kind).toBe(2); output.writeUInt32LE(acl.count); return 1; }),
    getAce: vi.fn((value, index, output) => { expect(value).toBe(dacl); expect(index).toBe(0); pointer(output, ace); return 1; }),
    equalSid: (a, b) => Number(a === b),
    close: vi.fn(() => 1),
    free: vi.fn(() => null),
  };
  return { acl, native };
};

test("reads independent native ACL facts and releases the descriptor, file and token", async () => {
  const { native } = fixture();
  await assertPrivateWindowsAcl("private.json", native);
  expect(native.openFile).toHaveBeenCalledWith(expect.any(String), 0x20000, 7, null, 3, 0x02000000, null);
  expect(native.free).toHaveBeenCalledExactlyOnceWith(descriptor);
  expect(vi.mocked(native.close).mock.calls).toEqual([[file], [token]]);
});

test.each([
  { field: "owner", value: 99n, error: "owner must be the current user" },
  { field: "owner", value: null, error: "owner must be the current user" },
  { field: "dacl", value: null, error: "non-null DACL" },
  { field: "control", value: 0x1000, error: "present and protected" },
  { field: "control", value: 4, error: "present and protected" },
  { field: "count", value: 0, error: "exactly one ACE" },
  { field: "count", value: 2, error: "exactly one ACE" },
  { field: "type", value: 1, error: "must allow access" },
  { field: "flags", value: 0x10, error: "no inheritance flags" },
  { field: "flags", value: 1, error: "no inheritance flags" },
  { field: "mask", value: 0x120089, error: "grant FullControl" },
  { field: "aceSid", value: 99n, error: "ACE must name the current user" },
])("rejects unsafe $field=$value and releases native resources", async ({ field, value, error }) => {
  const { acl, native } = fixture();
  Object.assign(acl, { [field]: value });
  await expect(assertPrivateWindowsAcl("private.json", native)).rejects.toThrow(error);
  expect(native.free).toHaveBeenCalledExactlyOnceWith(descriptor);
  expect(vi.mocked(native.close).mock.calls).toEqual([[file], [token]]);
});

test.each([
  { method: "openToken", stage: "open-token", result: 0, closed: [], freed: false },
  { method: "openFile", stage: "open-file", result: -1n, closed: [token], freed: false },
  { method: "security", stage: "get-security", result: 5, closed: [file, token], freed: false },
  { method: "control", stage: "descriptor-control", result: 0, closed: [file, token], freed: true },
  { method: "aclInformation", stage: "acl-information", result: 0, closed: [file, token], freed: true },
  { method: "getAce", stage: "get-ace", result: 0, closed: [file, token], freed: true },
] as const)("reports $stage failure and releases only acquired resources", async ({ method, stage, result, closed, freed }) => {
  const { native } = fixture();
  Object.assign(native, { [method]: vi.fn(() => result) });
  await expect(assertPrivateWindowsAcl("private.json", native)).rejects.toMatchObject({ stage, win32Code: method === "security" ? 5 : 122 });
  expect(vi.mocked(native.close).mock.calls).toEqual(closed.map(handle => [handle]));
  expect(native.free).toHaveBeenCalledTimes(Number(freed));
});

test.each(["size", "read"])("reports TokenUser %s failure and closes its token", async mode => {
  const { native } = fixture();
  if (mode === "size") native.lastError = () => 5;
  else vi.mocked(native.tokenInformation).mockImplementationOnce((_handle, _kind, _output, _length, returned) => { returned.writeUInt32LE(32); return 0; }).mockImplementationOnce(() => 0);
  await expect(assertPrivateWindowsAcl("private.json", native)).rejects.toMatchObject({ stage: mode === "size" ? "token-user-size" : "token-user", win32Code: mode === "size" ? 5 : 122 });
  expect(vi.mocked(native.close).mock.calls).toEqual([[token]]);
  expect(native.free).not.toHaveBeenCalled();
});

test("retains the original observation failure and every cleanup failure", async () => {
  const { native } = fixture();
  const original = new Error("native read failed");
  vi.mocked(native.control).mockImplementation(() => { throw original; });
  vi.mocked(native.free).mockReturnValue(descriptor);
  vi.mocked(native.close).mockReturnValue(0);
  const error = await assertPrivateWindowsAcl("private.json", native).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as Error).cause).toBe(original);
  expect((error as AggregateError).errors).toEqual([
    original,
    expect.objectContaining({ stage: "free-descriptor", win32Code: 122 }),
    expect.objectContaining({ stage: "close-file", win32Code: 122 }),
    expect.objectContaining({ stage: "close-token", win32Code: 122 }),
  ]);
  expect(vi.mocked(native.close).mock.calls).toEqual([[file], [token]]);
});

test.each(["free-descriptor", "close-file", "close-token"])("exposes %s cleanup failure after a successful observation", async stage => {
  const { native } = fixture();
  if (stage === "free-descriptor") vi.mocked(native.free).mockReturnValue(descriptor);
  else vi.mocked(native.close).mockImplementation(handle => Number(handle !== (stage === "close-file" ? file : token)));
  await expect(assertPrivateWindowsAcl("private.json", native)).rejects.toMatchObject({ stage, win32Code: 122 });
  expect(vi.mocked(native.close).mock.calls).toEqual([[file], [token]]);
});
