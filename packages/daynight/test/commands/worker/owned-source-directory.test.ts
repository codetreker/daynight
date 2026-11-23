import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeOwnedSourceDirectory } from "../../../src/commands/worker/owned-source-directory.js";
import { skipWithoutSymbolicLinks } from "../../helpers/symlink-support.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(unlink).mockImplementation(actualFs.unlink);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("owned source directory deletion", () => {
  it("removes only the selected source directory and rejects root deletion", async () => {
    const base = path.resolve("../../.tmp/resource-disposal-tests"); await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
    const source = path.join(root, "recordings", uuid(41)), other = path.join(root, "other");
    await mkdir(source, { recursive: true }); await mkdir(other); await writeFile(path.join(other, "keep"), "keep");
    await writeFile(path.join(source, "frame.json"), "frame");
    await expect(removeOwnedSourceDirectory(path.join(root, "recordings"), path.join(root, "recordings"))).rejects.toThrow();
    await removeOwnedSourceDirectory(path.join(root, "recordings"), source);
    expect(await readFile(path.join(other, "keep"), "utf8")).toBe("keep");
    await expect(readFile(path.join(source, "frame.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(skipWithoutSymbolicLinks)("refuses a source containing a symbolic link and leaves its target untouched", async () => {
    const base = path.resolve("../../.tmp/resource-disposal-tests"); await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
    const source = path.join(root, "recordings", uuid(41)), other = path.join(root, "other");
    await mkdir(source, { recursive: true }); await mkdir(other); await writeFile(path.join(other, "keep"), "keep");
    await writeFile(path.join(source, "frame.json"), "frame");
    await symlink(other, path.join(source, "linked"));
    await expect(removeOwnedSourceDirectory(path.join(root, "recordings"), source)).rejects.toThrow(/symbolic/);
    expect(await readFile(path.join(other, "keep"), "utf8")).toBe("keep");
    expect(await readFile(path.join(source, "frame.json"), "utf8")).toBe("frame");
  });

  it("rechecks the original recording source before each mutation", async () => {
    const base = path.resolve("../../.tmp/resource-disposal-tests"); await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
    const recordings = path.join(root, "recordings"), source = path.join(recordings, uuid(41)), moved = path.join(root, "moved");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "one"), "one"); await writeFile(path.join(source, "two"), "two");
    vi.mocked(unlink).mockImplementation(async target => {
      await actualFs.unlink(target);
      await rename(recordings, moved);
      await mkdir(recordings);
      await rename(path.join(moved, uuid(41)), source);
    });
    await expect(removeOwnedSourceDirectory(recordings, source)).rejects.toThrow(/identity changed/);
    expect(await readdir(source)).toHaveLength(1);
    expect(vi.mocked(unlink)).toHaveBeenCalledOnce();
  });
});
