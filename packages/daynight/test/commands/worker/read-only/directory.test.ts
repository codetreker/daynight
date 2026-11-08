import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browseWorkerDirectory, createWorkerDirectoryBrowser, type DirectoryFileSystem } from "../../../../src/commands/worker/read-only/directory.js";

let root: string;
beforeEach(async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  root = await realpath(await mkdtemp(path.join(scratch, "directory-read-")));
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
const options = () => ({ defaultCwd: root, signal: new AbortController().signal });
const fakeFileSystem = (names: readonly string[] = []): DirectoryFileSystem => ({
  realpath: async value => value,
  stat: async () => ({ directory: true, identity: "1:2", revision: "3:4" }),
  access: async () => undefined,
  openDirectory: async () => {
    let offset = 0;
    return { read: async () => {
      const name = names[offset++];
      return name === undefined ? null : { name, directory: true, symbolicLink: false };
    }, close: async () => undefined };
  },
});

describe("Worker directory browsing", () => {
  it("uses the target default, returns only directory names and leaves file bytes unchanged", async () => {
    await mkdir(path.join(root, "zeta")); await mkdir(path.join(root, "alpha")); await mkdir(path.join(root, ".hidden"));
    const file = path.join(root, "secret.txt"); await writeFile(file, "unchanged private content");
    if (process.platform !== "win32") await writeFile(path.join(root, "ignored\nfile"), "ignored");
    const before = await stat(file);
    const result = await browseWorkerDirectory({}, options());
    expect(result).toEqual({ path: root, parentPath: path.dirname(root), entries: [
      { name: "alpha", path: path.join(root, "alpha") }, { name: "zeta", path: path.join(root, "zeta") },
    ], nextCursor: null });
    expect(await readFile(file, "utf8")).toBe("unchanged private content");
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("normalizes symbolic links and does not restrict browsing to the default cwd", async () => {
    const target = path.join(root, "target"), link = path.join(root, "alias");
    await mkdir(target); await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(root, "file"), "private");
    if (process.platform !== "win32") await symlink(path.join(root, "file"), path.join(root, "file-alias"));
    const result = await browseWorkerDirectory({ path: link }, { ...options(), defaultCwd: target });
    expect(result.path).toBe(target); expect(result.entries).toEqual([]);
    expect((await browseWorkerDirectory({ path: root }, { ...options(), defaultCwd: target })).entries.map(item => item.name)).toEqual(["alias", "target"]);
  });

  it("paginates deterministically without duplicates and binds cursors to current-layer options", async () => {
    await Promise.all(["d", "a", "c", "b", ".hidden"].map(name => mkdir(path.join(root, name))));
    const first = await browseWorkerDirectory({ limit: 2 }, options());
    expect(first.entries.map(item => item.name)).toEqual(["a", "b"]); expect(first.nextCursor).not.toBeNull();
    const second = await browseWorkerDirectory({ limit: 2, cursor: first.nextCursor! }, options());
    expect(second.entries.map(item => item.name)).toEqual(["c", "d"]); expect(second.nextCursor).toBeNull();
    await expect(browseWorkerDirectory({ cursor: first.nextCursor!, showHidden: true }, options())).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(browseWorkerDirectory({ cursor: first.nextCursor! + "x" }, options())).rejects.toMatchObject({ code: "invalid_cursor" });
    await mkdir(path.join(root, "new"));
    await expect(browseWorkerDirectory({ cursor: first.nextCursor! }, options())).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("filters only names in the current layer and makes hidden names opt-in", async () => {
    await mkdir(path.join(root, "Alpha")); await mkdir(path.join(root, ".Alpha"));
    await mkdir(path.join(root, "outer")); await mkdir(path.join(root, "outer", "Alpha-nested"));
    expect((await browseWorkerDirectory({ filter: "alpha" }, options())).entries.map(item => item.name)).toEqual(["Alpha"]);
    expect((await browseWorkerDirectory({ filter: "alpha", showHidden: true }, options())).entries.map(item => item.name)).toEqual([".Alpha", "Alpha"]);
  });

  it("distinguishes empty, missing, non-directory and invalid input", async () => {
    expect((await browseWorkerDirectory({}, options())).entries).toEqual([]);
    await expect(browseWorkerDirectory({ path: path.join(root, "absent") }, options())).rejects.toMatchObject({ code: "not_found" });
    await writeFile(path.join(root, "file"), "bytes");
    await expect(browseWorkerDirectory({ path: path.join(root, "file") }, options())).rejects.toMatchObject({ code: "invalid_path" });
    for (const invalid of ["relative", "", "a\0b", "/" + "x".repeat(4096)]) {
      await expect(browseWorkerDirectory({ path: invalid }, options())).rejects.toMatchObject({ code: "invalid_path" });
    }
    await expect(browseWorkerDirectory({ limit: 101 }, options())).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports real OS read permission failures", async () => {
    const denied = path.join(root, "denied"); await mkdir(denied); await chmod(denied, 0);
    try { await expect(browseWorkerDirectory({ path: denied }, options())).rejects.toMatchObject({ code: "permission_denied" }); }
    finally { await chmod(denied, 0o700); }
  });

  it("reports an inaccessible parent without hiding a readable current directory", async () => {
    const fs = fakeFileSystem();
    fs.access = async target => { if (target === "/") throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    const browse = createWorkerDirectoryBrowser({ filesystem: fs, platform: "linux" });
    expect((await browse({}, { ...options(), defaultCwd: "/child" })).parentPath).toBeNull();
  });

  it("handles controlled Windows drive and UNC paths without using POSIX roots", async () => {
    const browse = createWorkerDirectoryBrowser({ filesystem: fakeFileSystem(["child"]), platform: "win32" });
    for (const directory of ["C:\\", "\\\\host\\share\\"]) {
      const result = await browse({}, { ...options(), defaultCwd: directory });
      expect(result.path).toBe(directory); expect(result.parentPath).toBeNull();
      expect(result.entries).toEqual([{ name: "child", path: path.win32.join(directory, "child") }]);
    }
    for (const invalid of ["C:relative", "\\relative", "/posix", "\\\\?\\C:\\", "\\\\host"]) {
      await expect(browse({ path: invalid }, options())).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("bounds scanning and closes handles on overflow instead of claiming an empty directory", async () => {
    const fs = fakeFileSystem(Array.from({ length: 10_001 }, (_, index) => `entry-${index}`));
    let closed = false;
    const open = fs.openDirectory;
    fs.openDirectory = async target => { const directory = await open(target); return { ...directory, close: async () => { closed = true; } }; };
    await expect(createWorkerDirectoryBrowser({ filesystem: fs })({}, options())).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(closed).toBe(true);
  });

  it("bounds page bytes while retaining a cursor for every omitted directory", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}-${"a".repeat(900)}`);
    const browse = createWorkerDirectoryBrowser({ filesystem: fakeFileSystem(names) });
    const first = await browse({ limit: 100 }, options());
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(65_536);
    expect(first.entries.length).toBeGreaterThan(0); expect(first.entries.length).toBeLessThan(100);
    const remaining = await browse({ cursor: first.nextCursor!, limit: 100 }, options());
    expect(remaining.entries[0]?.name).toBe(names[first.entries.length]);
    const oversized = createWorkerDirectoryBrowser({ filesystem: fakeFileSystem(["x".repeat(1025)]) });
    await expect(oversized({}, options())).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("returns cancellation promptly and holds occupied slots until suspended syscalls settle", async () => {
    const pending: (() => void)[] = [];
    const fs = fakeFileSystem();
    fs.realpath = target => new Promise(resolve => { pending.push(() => resolve(target)); });
    const browse = createWorkerDirectoryBrowser({ filesystem: fs });
    for (let index = 0; index < 4; index++) {
      const controller = new AbortController();
      const request = browse({}, { ...options(), signal: controller.signal });
      controller.abort();
      await expect(request).rejects.toMatchObject({ code: "cancelled" });
    }
    await expect(browse({}, options())).rejects.toMatchObject({ code: "limit_exceeded" });
    for (const resolve of pending) resolve();
    await vi.waitFor(async () => {
      fs.realpath = async value => value;
      expect((await browse({}, options())).entries).toEqual([]);
    });
  });

  it("distinguishes OS failures from empty results and avoids work after pre-cancellation", async () => {
    const fs = fakeFileSystem();
    for (const [code, expected] of [["EPERM", "permission_denied"], ["ENOENT", "not_found"], ["ENOTDIR", "invalid_path"], ["EIO", "io_error"]]) {
      fs.realpath = async () => { throw Object.assign(new Error("private OS diagnostic"), { code }); };
      const browse = createWorkerDirectoryBrowser({ filesystem: fs });
      await expect(browse({}, options())).rejects.toMatchObject({ code: expected });
    }
    const controller = new AbortController(); controller.abort();
    fs.realpath = vi.fn();
    await expect(createWorkerDirectoryBrowser({ filesystem: fs })({}, { ...options(), signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.realpath).not.toHaveBeenCalled();
  });

  it("rejects cursors from another Worker browser and another directory", async () => {
    const browse = createWorkerDirectoryBrowser({ filesystem: fakeFileSystem(["a", "b"]) });
    const first = await browse({ limit: 1 }, options());
    await expect(browse({ path: path.join(root, "different"), cursor: first.nextCursor! }, options())).rejects.toMatchObject({ code: "invalid_cursor" });
    const other = createWorkerDirectoryBrowser({ filesystem: fakeFileSystem(["a", "b"]) });
    await expect(other({ cursor: first.nextCursor! }, options())).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("times out suspended syscalls and never returns a late successful result", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const fs = fakeFileSystem();
    fs.realpath = target => new Promise(resolve => { release = () => resolve(target); });
    const browse = createWorkerDirectoryBrowser({ filesystem: fs });
    const request = browse({}, options());
    const outcome = request.catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000); expect(await outcome).toMatchObject({ code: "timeout" }); release();
  });
});
