import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, rmSync, fsyncSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ensureDurableDirectory } from "../../../src/platform/durable-directory.js";
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});
const directories: string[] = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fixture = () => {
  mkdirSync("../../.tmp/durable-directory", { recursive: true });
  const root = mkdtempSync(path.resolve("../../.tmp/durable-directory/run-")); directories.push(root); return root;
};
test.skipIf(process.platform === "win32")("syncs every newly created directory entry into its parent before returning", () => {
  const root = fixture(), directory = path.join(root, "recordings", "session", "frames"), observed: number[] = [];
  vi.mocked(fsyncSync).mockImplementation(fd => { observed.push(fstatSync(fd).ino); });
  ensureDurableDirectory(directory);
  for (const value of [root, path.dirname(path.dirname(directory)), path.dirname(directory), directory]) expect(observed).toContain(lstatSync(value).ino);
});
test.skipIf(process.platform === "win32")("rejects a directory when its new entry cannot be synced into its parent", () => {
  const root = fixture(), recordings = path.join(root, "recordings"), parent = lstatSync(root).ino;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (existsSync(recordings) && fstatSync(fd).ino === parent) throw Object.assign(new Error("parent sync failed"), { code: "EIO" }); });
  expect(() => ensureDurableDirectory(recordings)).toThrow("parent sync failed");
  // Retrying an interrupted mkdir must sync the already visible directory entry.
  expect(() => ensureDurableDirectory(recordings)).toThrow("parent sync failed");
});
