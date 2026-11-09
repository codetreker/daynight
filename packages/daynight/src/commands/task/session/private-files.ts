import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type PrivateOperationDirectory = {
  read(name: string): Promise<Buffer | undefined>;
  lock(name: string): Promise<() => Promise<void>>;
  replace(name: string, bytes: Buffer): Promise<void>;
  close(): Promise<void>;
};
export type PrivateOperationFiles = { open(directory: string, create: boolean): Promise<PrivateOperationDirectory | undefined> };
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const fail = (): never => { throw new Error("Operation recovery storage is not a private, owned regular filesystem object."); };
const privateStat = (stat: Stats, directory: boolean): void => {
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail();
};
let flockPromise: Promise<(fd: number, flags: number) => number> | undefined;
const flock = (): Promise<(fd: number, flags: number) => number> => flockPromise ??= (async () => {
  const koffi = await import("koffi");
  const library = koffi.load(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6");
  return library.func("int flock(int fd, int operation)") as (fd: number, flags: number) => number;
})();
const fileOpen = async (target: string, create: boolean): Promise<FileHandle> => {
  const flags = constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  if (create) {
    try { return await open(target, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return open(target, flags);
};

export const posixOperationFiles: PrivateOperationFiles = {
  open: async (directory, create) => {
    const actor = directory, origin = path.dirname(actor), managed = path.dirname(origin), root = path.dirname(managed);
    const handles: { path: string; handle: FileHandle; dev: number | bigint; ino: number | bigint }[] = [];
    const close = async (): Promise<void> => { const failures: unknown[] = []; for (const item of handles.reverse()) { try { await item.handle.close(); } catch (error) { failures.push(error); } } handles.length = 0; if (failures.length) throw new AggregateError(failures, "Recovery directory close failed."); };
    const verify = async (): Promise<void> => {
      for (const item of handles) { const stat = await lstat(item.path); if (!stat.isDirectory() || stat.dev !== item.dev || stat.ino !== item.ino) fail(); if (item.path !== root) privateStat(stat, true); }
    };
    try {
      for (const target of [root, managed, origin, actor]) {
        if (target !== root && create) { try { await mkdir(target, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
        let handle: FileHandle;
        try { handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
        catch (error) { if (!create && isMissing(error)) { await close(); return undefined; } throw error; }
        const stat = await handle.stat();
        handles.push({ path: target, handle, dev: stat.dev, ino: stat.ino });
        if (!stat.isDirectory()) fail();
        if (target !== root) privateStat(stat, true);
        if (create) {
          // Repeat both barriers for visible directories left by an interrupted mkdir.
          await handle.sync();
          if (handles.length > 1) await handles[handles.length - 2]!.handle.sync();
        }
      }
      const parent = handles.at(-1)!.handle;
      return {
        close,
        read: async name => {
          await verify();
          let file: FileHandle;
          try { file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
          catch (error) { if (isMissing(error)) return undefined; throw error; }
          try {
            const stat = await file.stat(); privateStat(stat, false);
            if (stat.size > 32_768) fail();
            const bytes = Buffer.alloc(32_769); let size = 0;
            while (size < bytes.length) { const chunk = await file.read(bytes, size, bytes.length - size, null); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
            if (size > 32_768) fail();
            await verify(); return bytes.subarray(0, size);
          } finally { await file.close(); }
        },
        lock: async name => {
          await verify();
          const file = await fileOpen(path.join(directory, name), true);
          try {
            privateStat(await file.stat(), false);
            const lock = await flock();
            if (lock(file.fd, 6) !== 0) throw new Error("Another process owns this operation submission. Query the original operation.");
            await verify();
            return async () => { await file.close(); };
          } catch (error) { await file.close(); throw error; }
        },
        replace: async (name, bytes) => {
          await verify();
          const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`), target = path.join(directory, name);
          let published = false;
          try {
            const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { privateStat(await file.stat(), false); await file.writeFile(bytes); await file.sync(); }
            finally { await file.close(); }
            await verify();
            try { privateStat(await lstat(target), false); } catch (error) { if (!isMissing(error)) throw error; }
            await rename(temporary, target); published = true;
            await parent.sync();
            await verify();
          } finally { if (!published) { try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; } } }
        },
      };
    } catch (error) { await close(); throw error; }
  },
};
export const loadOperationFiles = async (): Promise<PrivateOperationFiles> => process.platform === "win32" ? (await import("./windows-files.js")).loadWindowsOperationFiles() : posixOperationFiles;
