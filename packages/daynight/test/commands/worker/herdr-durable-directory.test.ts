import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, rmSync, fsyncSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ensureHerdrDurableDirectory } from "../../../src/commands/worker/herdr/durable-directory.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";
import type { SessionV2Owner } from "../../../src/session/v2/types.js";
import archive from "../../session/fixtures/v2/valid-archive.json" with { type: "json" };
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
test("syncs every newly created directory entry into its parent before returning", () => {
  const root = fixture(), directory = path.join(root, "recordings", "session", "frames"), observed: number[] = [];
  vi.mocked(fsyncSync).mockImplementation(fd => { observed.push(fstatSync(fd).ino); });
  ensureHerdrDurableDirectory(directory);
  for (const value of [root, path.dirname(path.dirname(directory)), path.dirname(directory), directory]) expect(observed).toContain(lstatSync(value).ino);
});
test("rejects recording preparation when its new root cannot be synced into the Worker directory", () => {
  const root = fixture(), recordings = path.join(root, "recordings"), directory = path.join(recordings, archive.sessionId), parent = lstatSync(root).ino;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (existsSync(recordings) && fstatSync(fd).ino === parent) throw Object.assign(new Error("parent sync failed"), { code: "EIO" }); });
  expect(() => openHerdrRecordingStore({ directory, owner: archive.owner as SessionV2Owner, sessionId: archive.sessionId, claimId: archive.claimId })).toThrow("parent sync failed");
  expect(existsSync(path.join(directory, "manifest.json"))).toBe(false);
  // Retrying an interrupted mkdir must sync the already visible directory entry.
  expect(() => ensureHerdrDurableDirectory(recordings)).toThrow("parent sync failed");
});
