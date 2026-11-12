import * as filesystem from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomicallyFromChunks } from "../../src/platform/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(filesystem.open).mockReset();
  vi.mocked(filesystem.rename).mockReset();
  vi.mocked(filesystem.unlink).mockReset();
  await Promise.all(directories.splice(0).map((directory) => filesystem.rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = path.resolve(import.meta.dirname, "../../../../.tmp/atomic-files-tests");
  await filesystem.mkdir(root, { recursive: true });
  const directory = await filesystem.mkdtemp(path.join(root, "file-"));
  directories.push(directory);
  const file = path.join(directory, "checkpoint.json");
  await filesystem.writeFile(file, "previous");
  return { directory, file };
};

const interceptHandle = async (install: (handle: FileHandle) => void) => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(filesystem.open).mockImplementation((async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await actual.open(...args);
    install(handle);
    return handle;
  }) as typeof filesystem.open);
};

describe("chunked atomic replacement", () => {
  it("writes async chunks in order, preserving UTF-8 across surrogate boundaries", async () => {
    const { directory, file } = await fixture();
    async function* chunks() {
      yield "hello \ud83d";
      yield "\ude80 ";
      yield Buffer.from("世界", "utf8");
      yield "!";
    }
    await replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
    expect(await filesystem.readFile(file, "utf8")).toBe("hello 🚀 世界!");
    expect(await filesystem.readdir(directory)).toEqual(["checkpoint.json"]);
    if (process.platform !== "win32") expect((await filesystem.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("finishes short writes before advancing to the next chunk", async () => {
    const { file } = await fixture();
    let writes = 0;
    await interceptHandle((handle) => {
      const actualWrite = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((async (buffer: Uint8Array, offset: number, length: number) => {
        writes++;
        return actualWrite(buffer, offset, Math.min(2, length));
      }) as typeof handle.write);
    });
    await replaceFileAtomicallyFromChunks(file, ["abcdef", Buffer.from("世界")]);
    expect(await filesystem.readFile(file, "utf8")).toBe("abcdef世界");
    expect(writes).toBe(6);
  });

  it("rejects zero-progress writes and preserves the previous file", async () => {
    const { directory, file } = await fixture();
    await interceptHandle((handle) => {
      vi.spyOn(handle, "write").mockImplementation((async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer })) as typeof handle.write);
    });
    await expect(replaceFileAtomicallyFromChunks(file, ["new"])).rejects.toThrow("write made no progress");
    expect(await filesystem.readFile(file, "utf8")).toBe("previous");
    expect(await filesystem.readdir(directory)).toEqual(["checkpoint.json"]);
  });

  it("preserves the write error and previous file after a partial write", async () => {
    const { directory, file } = await fixture();
    const failure = new Error("write failed");
    await interceptHandle((handle) => {
      const actualWrite = handle.write.bind(handle);
      let first = true;
      vi.spyOn(handle, "write").mockImplementation((async (buffer: Uint8Array, offset: number, length: number) => {
        if (!first) throw failure;
        first = false;
        return actualWrite(buffer, offset, Math.min(2, length));
      }) as typeof handle.write);
    });
    await expect(replaceFileAtomicallyFromChunks(file, ["new contents"])).rejects.toBe(failure);
    expect(await filesystem.readFile(file, "utf8")).toBe("previous");
    expect(await filesystem.readdir(directory)).toEqual(["checkpoint.json"]);
  });

  it("retains iteration and cleanup failures while preserving the previous file", async () => {
    const { directory, file } = await fixture();
    const failure = new Error("iteration failed");
    const cleanup = new Error("unlink failed");
    vi.mocked(filesystem.unlink).mockRejectedValueOnce(cleanup);
    async function* chunks() { yield "partial"; throw failure; }
    try {
      await replaceFileAtomicallyFromChunks(file, chunks());
      expect.unreachable("The write must fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure, cleanup]);
    }
    expect(await filesystem.readFile(file, "utf8")).toBe("previous");
    expect((await filesystem.readdir(directory)).filter((name) => name.startsWith(".atomic-"))).toHaveLength(1);
  });

  it.each(["close", "rename"] as const)("keeps the previous file on %s failure", async (stage) => {
    const { directory, file } = await fixture();
    const failure = new Error(`${stage} failed`);
    if (stage === "close") {
      await interceptHandle((handle) => { vi.spyOn(handle, "close").mockRejectedValueOnce(failure); });
    } else {
      vi.mocked(filesystem.rename).mockRejectedValueOnce(failure);
    }
    await expect(replaceFileAtomicallyFromChunks(file, ["new"])).rejects.toBe(failure);
    expect(await filesystem.readFile(file, "utf8")).toBe("previous");
    expect(await filesystem.readdir(directory)).toEqual(["checkpoint.json"]);
  });

  it("does not publish or finish while the source is still active", async () => {
    const { file } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    async function* chunks() { yield "first"; started(); await gate; yield "second"; }
    let finished = false;
    const pending = replaceFileAtomicallyFromChunks(file, chunks()).then(() => { finished = true; });
    try {
      await entered;
      expect(finished).toBe(false);
      expect(await filesystem.readFile(file, "utf8")).toBe("previous");
    } finally {
      release();
      await pending;
    }
    expect(await filesystem.readFile(file, "utf8")).toBe("firstsecond");
  });
});
