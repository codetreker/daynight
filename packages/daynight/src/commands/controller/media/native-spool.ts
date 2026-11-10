import { constants, chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export type NativeMediaSpool = {
  readonly path: string;
  write(bytes: Uint8Array): void;
  seal(): void;
  read(): Iterable<Uint8Array>;
  remove(): void;
};

/** Wire staging uses the same media owner as uploads, capture and native pins. */
export const openNativeMediaSpool = (filename: string, maximumBytes: number, reserve: (bytes: number) => void, removed: () => void): NativeMediaSpool => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 134_217_728) throw new Error("Native media spool maximum exceeds its bound.");
  reserve(0);
  let writer: number | null = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(writer);
  let bytes = 0, sealed = false, deleted = false, unlinked = false, removalSynced = false, readers = 0;
  const syncParent = () => {
    if (process.platform === "win32") return;
    const fd = openSync(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const original = () => {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size !== bytes) throw new Error("Native media spool identity or length changed.");
    return stat;
  };
  return {
    path: filename,
    write(chunk) {
      if (unlinked) throw new Error("Native media spool was removed.");
      if (sealed || writer === null) throw new Error("Native media spool is sealed.");
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65_536) throw new Error("Native media spool chunk exceeds its bound.");
      if (bytes + chunk.byteLength > maximumBytes) throw new Error("Native media spool exceeds its bound.");
      reserve(bytes + chunk.byteLength);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = writeSync(writer, chunk, offset, chunk.byteLength - offset, bytes);
        if (written === 0) throw new Error("Native media spool write made no progress.");
        bytes += written; offset += written;
      }
    },
    seal() {
      if (unlinked) throw new Error("Native media spool was removed.");
      if (sealed) return;
      original();
      if (writer !== null) { fsyncSync(writer); closeSync(writer); writer = null; }
      chmodSync(filename, 0o400); syncParent(); sealed = true;
    },
    *read() {
      if (unlinked) throw new Error("Native media spool was removed.");
      if (!sealed) throw new Error("Native media spool must be sealed before reading.");
      original();
      const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size !== bytes) throw new Error("Native media spool identity changed.");
        readers++;
        try {
          for (let offset = 0; offset < bytes;) {
            const chunk = Buffer.alloc(Math.min(65_536, bytes - offset));
            const count = readSync(fd, chunk, 0, chunk.length, offset);
            if (count !== chunk.length) throw new Error("Native media spool is truncated.");
            offset += count; yield chunk;
          }
        } finally { readers--; }
      } finally { closeSync(fd); }
    },
    remove() {
      if (deleted) return;
      if (readers !== 0) throw new Error("Native media spool still has an active reader.");
      if (!unlinked) {
        original();
        if (writer !== null) { closeSync(writer); writer = null; }
        unlinkSync(filename); unlinked = true;
      }
      if (!removalSynced) { syncParent(); removalSynced = true; }
      removed(); deleted = true;
    },
  };
};
