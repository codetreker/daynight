import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { openNativeMediaSpool } from "../../../src/commands/controller/media/native-spool.js";

const faults = vi.hoisted(() => ({ sync: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: (fd: number) => { if (faults.sync) { faults.sync = false; throw new Error("controlled directory sync failure"); } fs.fsyncSync(fd); } };
});
const directories: string[] = [];
afterEach(async () => { faults.sync = false; await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
test.skipIf(process.platform === "win32")("an unlinked spool retains its charge until POSIX directory sync succeeds on retry", async () => {
  const root = path.resolve("../../.tmp/native-spool-tests"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "wire-")); directories.push(directory);
  let charged = 0;
  const removed = vi.fn(() => { charged = 0; });
  const spool = openNativeMediaSpool(path.join(directory, "bytes"), 1024, bytes => { charged = bytes; }, removed);
  spool.write(Buffer.from("original bytes")); spool.seal(); faults.sync = true;
  expect(() => spool.remove()).toThrow(/sync failure/);
  await expect(stat(spool.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(charged).toBe(14); expect(removed).not.toHaveBeenCalled();
  spool.remove(); expect(charged).toBe(0); expect(removed).toHaveBeenCalledOnce();
});

test.skipIf(process.platform === "win32")("a failed POSIX directory sync while sealing can finish without reopening the immutable file", async () => {
  const root = path.resolve("../../.tmp/native-spool-tests"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "seal-")); directories.push(directory);
  let charged = 0;
  const spool = openNativeMediaSpool(path.join(directory, "bytes"), 1024, bytes => { charged = bytes; }, () => { charged = 0; });
  spool.write(Buffer.from("original bytes"));
  // The second fsync belongs to the parent directory after the writer closed.
  const fs = await import("node:fs"), sync = fs.fsyncSync;
  let calls = 0;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (++calls === 2) throw new Error("controlled directory sync failure"); sync(fd); });
  try { expect(() => spool.seal()).toThrow(/sync failure/); spool.seal(); expect(Buffer.concat([...spool.read()])).toEqual(Buffer.from("original bytes")); spool.remove(); expect(charged).toBe(0); }
  finally { vi.restoreAllMocks(); }
});

test("a failed file sync leaves the spool charged and unreadable until sealing succeeds", async () => {
  const root = path.resolve("../../.tmp/native-spool-tests"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "file-sync-")); directories.push(directory);
  let charged = 0;
  const spool = openNativeMediaSpool(path.join(directory, "bytes"), 1024, bytes => { charged = bytes; }, () => { charged = 0; });
  spool.write(Buffer.from("original bytes")); faults.sync = true;
  expect(() => spool.seal()).toThrow(/sync failure/);
  expect(charged).toBe(14); expect(() => [...spool.read()]).toThrow(/sealed/);
  spool.seal(); expect(Buffer.concat([...spool.read()])).toEqual(Buffer.from("original bytes"));
  spool.remove(); expect(charged).toBe(0);
});
