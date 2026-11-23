import { describe, expect, it } from "vitest";
import { closeSync, constants, openSync } from "node:fs";
import { isSupportedLocalImageFilesystem } from "../../../../src/commands/controller/markdown/local-source-filesystem.js";

describe("local image filesystem records", () => {
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
