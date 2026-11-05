import path from "node:path";
import { performance } from "node:perf_hooks";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { removeWorktreeContents } from "../../../src/commands/worker/remove-worktree-contents.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-content-tests");
const roots: string[] = [];
const restoreModes: string[] = [];
const operations: Operation[] = [];
const operation = (signal?: AbortSignal): Operation => {
  const result = createOperation(signal === undefined ? {} : { signal });
  operations.push(result);
  return result;
};
const identity = async (target: string): Promise<string> => {
  const entry = await lstat(target, { bigint: true });
  return `${entry.dev}:${entry.ino}`;
};
const fixture = async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "content-")); roots.push(root);
  const target = path.join(root, "worktree"); await mkdir(target);
  await writeFile(path.join(target, ".git"), "gitdir: retained\n");
  return { root, target, identity: await identity(target) };
};
const renameReadOnlyFixtureDirectory = async (source: string, destination: string, changeMode: FileHandle["chmod"]): Promise<void> => {
  // Darwin requires directory write permission even when a rename keeps the same parent.
  // https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html
  await changeMode(0o755);
  try { await rename(source, destination); }
  finally { await changeMode(0o555); }
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

afterEach(async () => {
  vi.mocked(open).mockImplementation(actualFs.open);
  try { operations.splice(0).forEach(entry => entry.dispose()); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  for (const target of restoreModes.splice(0)) {
    try { if (!(await lstat(target)).isSymbolicLink()) await chmod(target, 0o700); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("owned worktree content removal", () => {
  it("removes nested content while retaining the original root and top-level Git pointer", async () => {
    const f = await fixture();
    const nested = path.join(f.target, "nested"); await mkdir(nested);
    await writeFile(path.join(nested, ".git"), "nested content");
    await writeFile(path.join(nested, "file"), "remove");
    await removeWorktreeContents(f.target, f.identity, operation(), async () => {});
    expect(await readdir(f.target)).toEqual([".git"]);
    expect(await identity(f.target)).toBe(f.identity);
    expect(await readFile(path.join(f.target, ".git"), "utf8")).toBe("gitdir: retained\n");
  });

  it.skipIf(process.platform === "win32")("adds only owner write to readable searchable directories", async () => {
    const f = await fixture();
    const nested = path.join(f.target, "cache"); await mkdir(nested);
    const file = path.join(nested, "module"); await writeFile(file, "remove");
    await chmod(nested, 0o555); restoreModes.push(nested);
    await chmod(f.target, 0o555); restoreModes.push(f.target);
    let observedMode = 0;
    await removeWorktreeContents(f.target, f.identity, operation(), async () => {}, async (target, options) => {
      if (String(target) === file) observedMode = (await lstat(nested)).mode & 0o777;
      await rm(target, options);
    });
    expect(observedMode).toBe(0o755);
    expect((await lstat(f.target)).mode & 0o777).toBe(0o755);
    expect(await readdir(f.target)).toEqual([".git"]);
  });

  it("keeps all content when ownership verification fails", async () => {
    const f = await fixture(); const failure = new Error("changed claim");
    await writeFile(path.join(f.target, "keep"), "retained");
    await expect(removeWorktreeContents(f.target, f.identity, operation(), async () => { throw failure; })).rejects.toBe(failure);
    expect(await readFile(path.join(f.target, "keep"), "utf8")).toBe("retained");
  });

  it("retains a root whose identity differs from the original ownership", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "keep"), "retained");
    await expect(removeWorktreeContents(f.target, "0:0", operation(), async () => {})).rejects.toThrow(/identity|changed/);
    expect(await readFile(path.join(f.target, "keep"), "utf8")).toBe("retained");
  });

  it("retains partial failure evidence and continues from actual contents on retry", async () => {
    const f = await fixture(); const failure = new Error("controlled I/O failure");
    await writeFile(path.join(f.target, "one"), "one"); await writeFile(path.join(f.target, "two"), "two");
    await expect(removeWorktreeContents(f.target, f.identity, operation(), async () => {}, async (target, options) => {
      await rm(target, options); throw failure;
    })).rejects.toBe(failure);
    expect((await readdir(f.target)).length).toBe(2);
    expect(await readFile(path.join(f.target, ".git"), "utf8")).toBe("gitdir: retained\n");
    await removeWorktreeContents(f.target, f.identity, operation(), async () => {});
    expect(await readdir(f.target)).toEqual([".git"]);
  });

  it.skipIf(process.platform === "win32").each(["directory", "symlink"])("rejects a directory replaced by a %s after opening it", async replacement => {
    const f = await fixture();
    const nested = path.join(f.target, "cache"); const moved = path.join(f.target, "moved"); const outside = path.join(f.root, "outside");
    await mkdir(nested); await mkdir(outside);
    await writeFile(path.join(nested, "owned"), "keep original"); await writeFile(path.join(outside, "foreign"), "keep outside");
    await chmod(nested, 0o555); await chmod(outside, 0o555); restoreModes.push(nested, moved, outside);
    vi.mocked(open).mockImplementation(async (filename, flags, mode) => {
      const handle = await actualFs.open(filename, flags, mode);
      try {
        if (String(filename) === nested) {
          await renameReadOnlyFixtureDirectory(nested, moved, handle.chmod.bind(handle));
          if (replacement === "symlink") await symlink(outside, nested);
          else { await mkdir(nested); await writeFile(path.join(nested, "foreign"), "keep replacement"); await chmod(nested, 0o555); }
        }
        return handle;
      } catch (error) { await handle.close(); throw error; }
    });
    await expect(removeWorktreeContents(f.target, f.identity, operation(), async () => {})).rejects.toThrow(/identity|changed/);
    expect((await lstat(moved)).mode & 0o777).toBe(0o555);
    expect((await lstat(outside)).mode & 0o777).toBe(0o555);
    expect(await readFile(path.join(moved, "owned"), "utf8")).toBe("keep original");
    expect(await readFile(path.join(outside, "foreign"), "utf8")).toBe("keep outside");
    if (replacement === "directory") expect(await readFile(path.join(nested, "foreign"), "utf8")).toBe("keep replacement");
    expect(await readFile(path.join(f.target, ".git"), "utf8")).toBe("gitdir: retained\n");
  });

  it.skipIf(process.platform === "win32")("uses the verified directory handle when a path changes during chmod", async () => {
    const f = await fixture();
    const nested = path.join(f.target, "cache"); const moved = path.join(f.target, "moved"); const outside = path.join(f.root, "outside");
    await mkdir(nested); await mkdir(outside); await writeFile(path.join(outside, "foreign"), "retained");
    await chmod(nested, 0o555); await chmod(outside, 0o555); restoreModes.push(nested, moved, outside);
    vi.mocked(open).mockImplementation(async (filename, flags, mode) => {
      const handle = await actualFs.open(filename, flags, mode);
      if (String(filename) === nested) {
        const changeMode = handle.chmod.bind(handle);
        handle.chmod = async desired => {
          await renameReadOnlyFixtureDirectory(nested, moved, changeMode);
          await symlink(outside, nested);
          expect((await handle.stat()).mode & 0o777).toBe(0o555);
          return changeMode(desired);
        };
      }
      return handle;
    });
    await expect(removeWorktreeContents(f.target, f.identity, operation(), async () => {})).rejects.toThrow(/identity|changed/);
    expect((await lstat(moved)).mode & 0o777).toBe(0o755);
    expect((await lstat(outside)).mode & 0o777).toBe(0o555);
    expect(await readFile(path.join(outside, "foreign"), "utf8")).toBe("retained");
    expect(await readFile(path.join(f.target, ".git"), "utf8")).toBe("gitdir: retained\n");
  });

  it.skipIf(process.platform === "win32")("preserves current non-owner permissions when adding owner write", async () => {
    const f = await fixture();
    await chmod(f.target, 0o555); restoreModes.push(f.target);
    vi.mocked(open).mockImplementation(async (filename, flags, mode) => {
      const handle = await actualFs.open(filename, flags, mode);
      if (String(filename) === f.target) await handle.chmod(0o500);
      return handle;
    });
    await removeWorktreeContents(f.target, f.identity, operation(), async () => {});
    expect((await lstat(f.target)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32").each(["uid", "dev"] as const)("rejects a directory handle whose %s changes before permission recovery", async field => {
    const f = await fixture(); const nested = path.join(f.target, "cache");
    await mkdir(nested); await writeFile(path.join(nested, "keep"), "retained");
    await chmod(nested, 0o555); restoreModes.push(nested);
    vi.mocked(open).mockImplementation(async (filename, flags, mode) => {
      const handle = await actualFs.open(filename, flags, mode);
      if (String(filename) === nested) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async options => {
          const entry = await stat(options);
          if (entry !== undefined && typeof entry[field] === "bigint") Object.defineProperty(entry, field, { value: entry[field] + 1n });
          return entry;
        }) as typeof handle.stat;
      }
      return handle;
    });
    await expect(removeWorktreeContents(f.target, f.identity, operation(), async () => {})).rejects.toThrow(/identity|owner|device/);
    expect((await lstat(nested)).mode & 0o777).toBe(0o555);
    expect(await readFile(path.join(nested, "keep"), "utf8")).toBe("retained");
  });

  it.skipIf(process.platform === "win32").each([0o155, 0o455])("rejects directories without owner read/search permissions (%s)", async mode => {
    const f = await fixture(); const nested = path.join(f.target, "cache");
    await mkdir(nested); await writeFile(path.join(nested, "keep"), "retained");
    await chmod(nested, mode); restoreModes.push(nested);
    await expect(removeWorktreeContents(f.target, f.identity, operation(), async () => {})).rejects.toThrow(/permission|read|search|EACCES/);
    expect((await lstat(nested)).mode & 0o777).toBe(mode);
    await chmod(nested, 0o700);
    expect(await readFile(path.join(nested, "keep"), "utf8")).toBe("retained");
  });

  it.each(["cancellation", "deadline"])("joins an in-flight removal after %s and starts no further mutations", async stop => {
    const f = await fixture();
    await writeFile(path.join(f.target, "one"), "one"); await writeFile(path.join(f.target, "two"), "two");
    const entered = deferred(); const release = deferred(); const controller = new AbortController();
    let elapsed = 0;
    if (stop === "deadline") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    }
    const op = stop === "cancellation" ? operation(controller.signal) : createOperation({ limits: { totalMs: 30 } });
    if (stop === "deadline") operations.push(op);
    let settled = false;
    const result = removeWorktreeContents(f.target, f.identity, op, async () => {}, async (target, options) => {
      entered.resolve(); await release.promise; await rm(target, options);
    }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await Promise.race([entered.promise, result.then(error => { throw error ?? new Error("Removal never entered the controlled filesystem operation."); })]);
    if (stop === "cancellation") controller.abort(new Error("stop"));
    else {
      elapsed = 30;
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(op.signal.aborted).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect((await readdir(f.target)).length).toBe(3);
    release.resolve();
    expect(await result).toBe(op.signal.reason);
    expect((await readdir(f.target)).length).toBe(2);
    expect(await readFile(path.join(f.target, ".git"), "utf8")).toBe("gitdir: retained\n");
  });
});
