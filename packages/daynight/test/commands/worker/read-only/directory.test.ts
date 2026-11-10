import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browseWorkerDirectory, createWorkerDirectoryBrowser, type DirectoryFileSystem, type WorkerDirectoryInput } from "../../../../src/commands/worker/read-only/directory.js";
import { startWorkerReadonlyPeers, WorkerReadonlyCleanupError, type WorkerReadonlyFrame } from "../../../fixtures/worker-readonly-peer.js";

let root: string;
let childrenDrained: boolean;
let encodingExecution: Promise<void> | undefined;
beforeEach(async () => {
  childrenDrained = true;
  encodingExecution = undefined;
  const scratch = path.resolve(import.meta.dirname, "../../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  root = await realpath(await mkdtemp(path.join(scratch, "directory-read-")));
});
afterEach(async () => {
  vi.useRealTimers();
  await encodingExecution?.catch(() => {});
  if (!childrenDrained) throw new Error(`Worker fixture directory retained because child shutdown was not confirmed: ${root}`);
  await rm(root, { recursive: true, force: true });
}, 90_000);
const areChildrenDrained = (error: unknown): boolean => {
  if (error instanceof WorkerReadonlyCleanupError && !error.childrenDrained) return false;
  return !(error instanceof AggregateError) || error.errors.every(areChildrenDrained);
};
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

  it("preserves exact encoded filenames across real Worker channel pages", () => {
    encodingExecution = (async () => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; }, 80_000);
      const checkDeadline = () => { if (expired) throw new Error("Worker encoding test exceeded its execution budget."); };
      try {
        const cases = [
          { id: "a", characters: "&".repeat(240) },
          ...(process.platform === "win32" ? [] : [{ id: "b", characters: "<>".repeat(120) }]),
          { id: "c", characters: "\u2028\u2029".repeat(40) },
        ];
        const paddingCount = 200 - Buffer.byteLength(path.join(root, "encoding-", "a"));
        expect(paddingCount).toBeGreaterThanOrEqual(0);
        const parentName = `encoding-${"p".repeat(paddingCount)}`;
        expect(Buffer.byteLength(parentName)).toBeLessThanOrEqual(255);
        const parent = path.join(root, parentName);
        await mkdir(parent);
        const actualParent = await realpath(parent);
        const directories = [];
        for (const item of cases) {
          checkDeadline();
          const directory = path.join(actualParent, item.id);
          await mkdir(directory);
          const actual = await realpath(directory);
          expect(Buffer.byteLength(actual)).toBe(200);
          expect(Buffer.byteLength(actual)).toBeLessThan(4096);
          const names = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${item.characters}`);
          for (const name of names) { checkDeadline(); await mkdir(path.join(actual, name)); }
          directories.push({ actual, names });
        }

        const target = { ownerUserId: randomUUID(), workerId: randomUUID(), serverToken: `dnpat_${Buffer.alloc(32, 1).toString("base64url")}`, defaultCwd: actualParent };
        let peers: Awaited<ReturnType<typeof startWorkerReadonlyPeers>> | undefined;
        let primary: unknown;
        try {
          checkDeadline();
          peers = await startWorkerReadonlyPeers([target]);
          let pages = 0, challengeObserved = false;
          let fence: WorkerReadonlyFrame | undefined;
          for (const directory of directories) {
            const names: string[] = [];
            let cursor: string | null = null;
            do {
              checkDeadline();
              const input: WorkerDirectoryInput = cursor === null
                ? { path: directory.actual, limit: 100 }
                : { path: directory.actual, limit: 100, cursor };
              const requestId = randomUUID();
              const { message, raw } = await peers.request(target.workerId, requestId, input);
              checkDeadline();
              expect(JSON.parse(raw.toString("utf8"))).toEqual(message);
              expect(message).toMatchObject({ type: "result", protocol: "daynight.worker-readonly.v1", ownerUserId: target.ownerUserId, workerId: target.workerId, requestId });
              expect(message.error).toBeUndefined();
              const current: WorkerReadonlyFrame = { protocol: message.protocol, ownerUserId: message.ownerUserId, workerId: message.workerId, connectionId: message.connectionId, capabilityGeneration: message.capabilityGeneration };
              expect(current.connectionId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
              expect(current.capabilityGeneration).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
              if (fence) expect(current).toEqual(fence); else fence = current;
              expect(message.result).toBeDefined();
              const result = message.result!;
              expect(result.path).toBe(directory.actual);
              for (const entry of result.entries) {
                expect(entry.path).toBe(path.join(directory.actual, entry.name));
                names.push(entry.name);
              }
              const nativeResultBytes = Buffer.byteLength(JSON.stringify(result));
              const legacyExpandedMessageBytes = Buffer.byteLength(raw.toString("utf8").replace(/[&<>\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
              expect(nativeResultBytes).toBeLessThanOrEqual(65_536);
              expect(raw.length).toBeLessThanOrEqual(256 * 1024);
              if (nativeResultBytes >= 60 * 1024 && legacyExpandedMessageBytes > 256 * 1024) challengeObserved = true;
              pages++;
              expect(pages).toBeLessThanOrEqual(12);
              cursor = result.nextCursor;
            } while (cursor !== null);
            expect(names).toEqual(directory.names);
          }
          expect(challengeObserved).toBe(true);
        } catch (error) { primary = error; }
        const errors: unknown[] = [];
        try { await peers?.close(); } catch (error) { errors.push(error); }
        if (primary !== undefined) errors.unshift(primary);
        childrenDrained = errors.every(areChildrenDrained);
        if (errors.length) throw new AggregateError(errors, "Worker encoding process test failed.");
      } finally { clearTimeout(timer); }
    })();
    return encodingExecution;
  }, 90_000);

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
