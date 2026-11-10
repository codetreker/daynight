import path from "node:path";
import { mkdir, mkdtemp, lstat, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { openDirectoryIdentity, publishDirectoryFile, readMacDirectoryIdentity } from "../../src/platform/directory-identity.js";
import type { AttributeQuery, DirectoryIdentityLease } from "../../src/platform/directory-identity.js";

const roots: string[] = [], leases: DirectoryIdentityLease[] = [];
const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/directory-identity-tests");
const fixture = async () => { await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "identity-")); roots.push(root); return root; };
afterEach(async () => { await Promise.all(leases.splice(0).map(lease => lease.close())); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const response = (common: number, volume: number, payload: Buffer) => {
  const bytes = Buffer.alloc(24 + payload.length); bytes.writeUInt32LE(bytes.length);
  bytes.writeUInt32LE((0x80000000 | common) >>> 0, 4); bytes.writeUInt32LE(volume, 8); payload.copy(bytes, 24); return bytes;
};
const query = (): AttributeQuery => (_fd, common, volume) => {
  if (common === 0x02000000 && volume === 0) { const data = Buffer.alloc(8); data.writeBigUInt64LE(9007199254740993n); return response(common, volume, data); }
  if (common !== 0) throw new Error("Unexpected attribute query");
  if (volume === 0x00100000) { const data = Buffer.alloc(13); data.writeInt32LE(8); data.writeUInt32LE(5, 4); data.write("apfs\0", 8); return response(common, volume, data); }
  if (volume === 0x00020000) { const data = Buffer.alloc(32); data.writeUInt32LE(1); data.writeUInt32LE(1, 16); return response(common, volume, data); }
  if (volume === 0x00040000) return response(common, volume, Buffer.from("4e19e7115e6b4fc5a078d14b179ed268", "hex"));
  throw new Error("Unexpected attribute query");
};

describe("APFS directory identity decoding", () => {
  it("preserves uint64 object IDs without rounding", () => {
    expect(readMacDirectoryIdentity(3, query())).toEqual({ kind: "supported", identity: { kind: "darwin-apfs-v1", volumeUuid: "4e19e711-5e6b-4fc5-a078-d14b179ed268", fileId: "9007199254740993" } });
  });
  it.each(["filesystem", "capability", "validity", "missing-uuid", "zero-uuid", "zero-id"])("does not authorize stable recovery with %s evidence", kind => {
    const base = query();
    const result = readMacDirectoryIdentity(3, (fd, common, volume) => {
      const bytes = base(fd, common, volume);
      if (kind === "filesystem" && volume === 0x00100000) bytes.write("ntfs", 32);
      if (kind === "capability" && volume === 0x00020000) bytes.writeUInt32LE(0, 24);
      if (kind === "validity" && volume === 0x00020000) bytes.writeUInt32LE(0, 40);
      if (kind === "missing-uuid" && volume === 0x00040000) bytes.writeUInt32LE(0, 8);
      if (kind === "zero-uuid" && volume === 0x00040000) bytes.fill(0, 24);
      if (kind === "zero-id" && common === 0x02000000) bytes.fill(0, 24);
      return bytes;
    });
    expect(result.kind).toBe("unsupported");
  });
  it.each(["truncated", "length", "bitmap", "reference", "uuid-size", "file-size", "capabilities-size"])("rejects malformed %s responses", kind => {
    const base = query();
    expect(() => readMacDirectoryIdentity(3, (fd, common, volume) => {
      const bytes = base(fd, common, volume);
      if (kind === "truncated") return bytes.subarray(0, 10);
      if (kind === "length") bytes.writeUInt32LE(bytes.length + 1);
      if (kind === "bitmap") bytes.writeUInt32LE(0, 4);
      if (kind === "reference" && volume === 0x00100000) bytes.writeInt32LE(-24, 24);
      if ((kind === "uuid-size" && volume === 0x00040000) || (kind === "file-size" && common === 0x02000000) || (kind === "capabilities-size" && volume === 0x00020000)) { bytes.writeUInt32LE(bytes.length - 1); return bytes.subarray(0, -1); }
      return bytes;
    })).toThrow();
  });
  it("preserves attribute IO errors instead of claiming unsupported evidence", () => {
    const failure = new Error("device IO failure");
    expect(() => readMacDirectoryIdentity(3, () => { throw failure; })).toThrow(failure);
  });
});

describe("directory identity leases", () => {
  it.skipIf(process.platform === "win32")("rejects symlinks and path replacements while retaining the opened directory", async () => {
    const root = await fixture(), directory = path.join(root, "directory"); await mkdir(directory);
    await symlink(directory, path.join(root, "alias"));
    await expect(openDirectoryIdentity(path.join(root, "alias"))).rejects.toThrow("ordinary directory");
    const lease = await openDirectoryIdentity(directory); leases.push(lease);
    await rename(directory, path.join(root, "original")); await mkdir(directory);
    await expect(lease.verifyPath()).rejects.toThrow("identity changed");
    expect((await lease.handle!.stat({ bigint: true })).ino).toBe(lease.runtime.ino);
  });
  it.skipIf(process.platform !== "darwin")("reads real APFS identities through a directory handle", async () => {
    const root = await fixture(); const first = await openDirectoryIdentity(root); leases.push(first);
    expect(first.stable.kind).toBe("supported");
    if (first.stable.kind !== "supported") throw new Error(first.stable.reason);
    expect(first.stable.identity.fileId).toBe((await lstat(root, { bigint: true })).ino.toString());
    await writeFile(path.join(root, "new-content"), "directory contents may change");
    const second = await openDirectoryIdentity(root); leases.push(second);
    expect(second.stable).toEqual(first.stable); await first.verifyPath();
  });
  it.skipIf(process.platform !== "darwin")("publishes without overwriting an existing destination", async () => {
    const root = await fixture(); const lease = await openDirectoryIdentity(root); leases.push(lease);
    await writeFile(path.join(root, "first"), "first"); await writeFile(path.join(root, "second"), "second");
    await publishDirectoryFile(lease, "first", "identity");
    await expect(publishDirectoryFile(lease, "second", "identity")).rejects.toMatchObject({ code: "EEXIST" });
    const file = await open(path.join(root, "identity")); try { expect(await file.readFile("utf8")).toBe("first"); } finally { await file.close(); }
    await expect(publishDirectoryFile(lease, "../escape", "identity")).rejects.toThrow("directory-local");
  });
});
