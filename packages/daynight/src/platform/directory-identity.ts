import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type StableDirectoryIdentity = { kind: "darwin-apfs-v1"; volumeUuid: string; fileId: string };
export type StableDirectorySample =
  | { kind: "supported"; identity: StableDirectoryIdentity }
  | { kind: "unsupported"; reason: string };
export type DirectoryIdentityLease = {
  handle: FileHandle | null;
  runtime: { dev: bigint; ino: bigint };
  stable: StableDirectorySample;
  verifyPath(): Promise<void>;
  close(): Promise<void>;
};
export type AttributeQuery = (fd: number, common: number, volume: number) => Buffer;
const returned = 0x80000000;
const volumeInfo = 0x80000000;
const unsupported = (reason: string): StableDirectorySample => ({ kind: "unsupported", reason });

type MacKernel = { query: AttributeQuery; publish(fd: number, source: string, target: string): void };
let kernelPromise: Promise<MacKernel> | undefined;
const macKernel = (): Promise<MacKernel> => kernelPromise ??= (async () => {
  const koffi = await import("koffi");
  const library = koffi.load("/usr/lib/libSystem.B.dylib");
  const attributes = library.func("int fgetattrlist(int fd, void *attributes, void *buffer, size_t size, unsigned long options)");
  const publish = library.func("int renameatx_np(int fromfd, const char *from, int tofd, const char *to, unsigned int flags)");
  const errno = library.func("void *__error(void)");
  const failure = (operation: string): Error => {
    const number = koffi.decode(errno(), "int") as number;
    return Object.assign(new Error(`${operation} failed (errno ${number}).`), { code: number === 17 ? "EEXIST" : number === 45 ? "ENOTSUP" : number === 22 ? "EINVAL" : `ERRNO_${number}` });
  };
  return {
    query: (fd, common, volume) => {
      const request = Buffer.alloc(24); request.writeUInt16LE(5);
      request.writeUInt32LE((common | returned) >>> 0, 4);
      request.writeUInt32LE(volume === 0 ? 0 : (volume | volumeInfo) >>> 0, 8);
      const buffer = Buffer.alloc(1024);
      if (attributes(fd, request, buffer, buffer.length, 0) !== 0) throw failure("fgetattrlist");
      const size = buffer.readUInt32LE(0);
      if (size < 24 || size > buffer.length) throw new Error("Invalid directory attribute response length.");
      return buffer.subarray(0, size);
    },
    publish: (fd, source, target) => {
      // RENAME_EXCL publishes only if the destination does not exist.
      // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_syscalls.c#L10240-L10251
      if (publish(fd, source, fd, target, 4) !== 0) throw failure("renameatx_np");
    },
  };
})();

export const readMacDirectoryIdentity = (fd: number, query: AttributeQuery): StableDirectorySample => {
  const read = (common: number, volume: number): Buffer | null => {
    const bytes = query(fd, common, volume);
    if (bytes.length < 24 || bytes.readUInt32LE(0) !== bytes.length) throw new Error("Invalid directory attribute response length.");
    if ((bytes.readUInt32LE(4) & returned) === 0) throw new Error("Directory attributes have no returned-attributes bitmap.");
    if ((bytes.readUInt32LE(4) & common) !== common || (bytes.readUInt32LE(8) & volume) !== volume) return null;
    return bytes;
  };
  const type = read(0, 0x00100000);
  if (type === null) return unsupported("Filesystem type is unavailable.");
  if (type.length < 32) throw new Error("Invalid filesystem type attribute.");
  const start = 24 + type.readInt32LE(24), length = type.readUInt32LE(28);
  if (start < 32 || length < 1 || start + length > type.length || type[start + length - 1] !== 0) throw new Error("Invalid filesystem type attribute.");
  if (type.toString("utf8", start, start + length - 1) !== "apfs") return unsupported("Stable directory recovery requires APFS.");
  const capabilities = read(0, 0x00020000);
  if (capabilities === null) return unsupported("Persistent object ID capability is unavailable.");
  if (capabilities.length !== 56) throw new Error("Invalid filesystem capabilities attribute.");
  // Both the validity and capability bits must establish persistence across remounts.
  // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/attr.h#L143-L147
  if ((capabilities.readUInt32LE(24) & capabilities.readUInt32LE(40) & 1) === 0) return unsupported("Filesystem object IDs are not persistent.");
  const volume = read(0, 0x00040000), file = read(0x02000000, 0);
  if (volume === null || file === null) return unsupported("Stable volume or object identity is unavailable.");
  if (volume.length !== 40 || file.length !== 32) throw new Error("Invalid stable directory identity attributes.");
  const hex = volume.subarray(24).toString("hex"), fileId = file.readBigUInt64LE(24);
  if (/^0+$/.test(hex) || fileId === 0n) return unsupported("Stable volume or object identity is empty.");
  return { kind: "supported", identity: { kind: "darwin-apfs-v1", volumeUuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, fileId: fileId.toString() } };
};

export const openDirectoryIdentity = async (target: string): Promise<DirectoryIdentityLease> => {
  const initial = await lstat(target, { bigint: true });
  if (!initial.isDirectory()) throw new Error(`Identity path ${target} must be an ordinary directory.`);
  const handle = process.platform === "win32" ? null : await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const check = (entry: BigIntStats): void => {
    if (!entry.isDirectory() || entry.dev !== initial.dev || entry.ino !== initial.ino || entry.uid !== initial.uid) throw new Error(`Directory identity changed: ${target}`);
  };
  const verifyPath = async (): Promise<void> => {
    if (handle !== null) check(await handle.stat({ bigint: true }));
    check(await lstat(target, { bigint: true }));
  };
  try {
    await verifyPath();
    let stable = unsupported("Stable directory recovery is unavailable on this platform.");
    if (process.platform === "darwin" && handle !== null) {
      try { stable = readMacDirectoryIdentity(handle.fd, (await macKernel()).query); }
      catch (error) {
        if (!["ENOTSUP", "EINVAL"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        stable = unsupported("Filesystem does not support stable directory attributes.");
      }
    }
    await verifyPath();
    return { handle, runtime: { dev: initial.dev, ino: initial.ino }, stable, verifyPath, close: async () => { await handle?.close(); } };
  } catch (error) {
    try { await handle?.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Directory identity inspection and close failed."); }
    throw error;
  }
};

export const publishDirectoryFile = async (directory: DirectoryIdentityLease, source: string, target: string): Promise<void> => {
  if (process.platform !== "darwin" || directory.handle === null) throw new Error("Atomic stable identity publication is unavailable on this platform.");
  if ([source, target].some(name => !name || name === "." || name === ".." || /[/\\\0]/.test(name))) throw new Error("Identity publication requires directory-local filenames.");
  await directory.verifyPath();
  (await macKernel()).publish(directory.handle.fd, source, target);
};
