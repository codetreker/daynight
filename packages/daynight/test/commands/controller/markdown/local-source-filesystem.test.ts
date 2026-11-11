import { describe, expect, it } from "vitest";
import { closeSync, constants, openSync } from "node:fs";
import { isSupportedLocalImageFilesystem } from "../../../../src/commands/controller/markdown/local-source-filesystem.js";

const darwinRecord = (name: string, type = 0x1a, flags = 0x1000): Buffer => {
  const bytes = Buffer.alloc(2168); bytes.writeUInt32LE(type, 60); bytes.writeUInt32LE(flags >>> 0, 64); Buffer.from(name).copy(bytes, 72, 0, 16); return bytes;
};
describe("local image filesystem records", () => {
  it.each([0, 1, 0x11, 0x1a, 0x1234, 0xffffffff])("accepts local APFS and HFS with kernel-assigned type %s", type => {
    for (const name of ["apfs", "hfs"]) expect(isSupportedLocalImageFilesystem(darwinRecord(name, type), "darwin")).toBe(true);
  });
  it.each(["nfs", "smbfs", "osxfuse", "macfuse", "devfs", "unknown", "APFS", "apfs-other", "", "apfs\ufffd"])("refuses unsupported Darwin filesystem %s despite a formerly allowed numeric type", name => {
    for (const type of [0x1a, 0x11]) expect(isSupportedLocalImageFilesystem(darwinRecord(name, type), "darwin")).toBe(false);
  });
  it("requires MNT_LOCAL even for a supported name and accepts unrelated mount flags", () => {
    expect(isSupportedLocalImageFilesystem(darwinRecord("apfs", 0x1a, 0), "darwin")).toBe(false);
    expect(isSupportedLocalImageFilesystem(darwinRecord("hfs", 0x11, 0xffffffff ^ 0x1000), "darwin")).toBe(false);
    expect(isSupportedLocalImageFilesystem(darwinRecord("apfs", 700, 0x04909080), "darwin")).toBe(true);
  });
  it("refuses FSKit mounts even with a supported local filesystem name", () => {
    for (const name of ["apfs", "hfs"]) {
      const bytes = darwinRecord(name); bytes.writeUInt32LE(2, 2136); expect(isSupportedLocalImageFilesystem(bytes, "darwin")).toBe(false);
      bytes.writeUInt32LE(3, 2136); expect(isSupportedLocalImageFilesystem(bytes, "darwin")).toBe(false);
      bytes.writeUInt32LE(1, 2136); expect(isSupportedLocalImageFilesystem(bytes, "darwin")).toBe(true);
      bytes.writeUInt32LE(0, 2136); expect(isSupportedLocalImageFilesystem(bytes, "darwin")).toBe(true);
    }
  });
  it("refuses short, unterminated and non-ASCII names", () => {
    const valid = darwinRecord("apfs");
    const unterminated = darwinRecord("abcdefghijklmnop");
    const nonAscii = darwinRecord("apfs"); nonAscii[72] = 0xe1;
    for (const bytes of [valid.subarray(0, 87), valid.subarray(0, 2139), Buffer.alloc(0), unterminated, nonAscii]) expect(isSupportedLocalImageFilesystem(bytes, "darwin")).toBe(false);
    expect(isSupportedLocalImageFilesystem(valid.subarray(0, 2140), "darwin")).toBe(true);
  });
  it.each([0xef53, 0x58465342, 0x9123683e, 0x01021994])("preserves supported Linux magic %s", type => {
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(type); expect(isSupportedLocalImageFilesystem(bytes, "linux")).toBe(true);
  });
  it.each([0, 0x6969, 0x65735546, 0x517b, 0xff534d42])("refuses unknown, network and userspace Linux magic %s", type => {
    const bytes = Buffer.alloc(88); bytes.writeUInt32LE(type); expect(isSupportedLocalImageFilesystem(bytes, "linux")).toBe(false);
  });
  it("does not reinterpret another ABI or a truncated Linux magic", () => {
    expect(isSupportedLocalImageFilesystem(Buffer.alloc(3), "linux")).toBe(false);
    expect(isSupportedLocalImageFilesystem(darwinRecord("apfs"), "freebsd")).toBe(false);
  });
  it.skipIf(process.platform !== "darwin")("recognizes the actual local Darwin filesystem by name and mount flags", async () => {
    const koffi = await import("koffi"), library = koffi.load("libSystem.B.dylib");
    const fstatfs = library.func(`fstatfs${process.arch === "x64" ? "$INODE64" : ""}`, "int", ["int", "void *"]);
    const fd = openSync(process.cwd(), constants.O_RDONLY | constants.O_DIRECTORY), bytes = Buffer.alloc(4096);
    try {
      expect(fstatfs(fd, bytes)).toBe(0);
      const field = bytes.subarray(72, 88), end = field.indexOf(0);
      const diagnostic = JSON.stringify({ platform: process.platform, architecture: process.arch, type: bytes.readUInt32LE(60), local: (bytes.readUInt32LE(64) & 0x1000) !== 0, flagsExt: bytes.readUInt32LE(2136), name: field.subarray(0, end < 0 ? field.length : end).toString("utf8") });
      expect(isSupportedLocalImageFilesystem(bytes, "darwin"), diagnostic).toBe(true);
    } finally { closeSync(fd); }
  });
});
