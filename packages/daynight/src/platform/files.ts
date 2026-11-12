import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const replaceFileAtomically = async (
  file: string,
  contents: string | Uint8Array,
  mode?: number,
): Promise<void> => replaceWithTemporaryFile(file, mode, async (handle) => {
  await handle.writeFile(contents);
});

export const replaceFileAtomicallyFromChunks = async (
  file: string,
  chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
  mode?: number,
): Promise<void> => replaceWithTemporaryFile(file, mode, async (handle) => {
  const write = async (bytes: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
      if (bytesWritten <= 0) {
        throw new Error("Atomic replacement write made no progress.");
      }
      offset += bytesWritten;
    }
  };

  // A string chunk may end between the two code units of a surrogate pair.
  let pendingHighSurrogate = "";
  for await (const chunk of chunks) {
    if (typeof chunk !== "string") {
      if (pendingHighSurrogate) {
        await write(Buffer.from(pendingHighSurrogate, "utf8"));
        pendingHighSurrogate = "";
      }
      await write(chunk);
      continue;
    }
    let value = pendingHighSurrogate + chunk;
    pendingHighSurrogate = "";
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      pendingHighSurrogate = value.slice(-1);
      value = value.slice(0, -1);
    }
    await write(Buffer.from(value, "utf8"));
  }
  if (pendingHighSurrogate) await write(Buffer.from(pendingHighSurrogate, "utf8"));
});

const replaceWithTemporaryFile = async (
  file: string,
  mode: number | undefined,
  write: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> => {
  const temporaryFile = path.join(path.dirname(file), `.atomic-${randomUUID()}.tmp`);
  const handle = await open(temporaryFile, "wx", 0o600);
  let failure: unknown;
  let renamed = false;
  let closed = false;
  try {
    await write(handle);
    if (mode !== undefined) {
      await handle.chmod(mode & 0o777);
    }
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporaryFile, file);
    renamed = true;
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    const cleanup: unknown[] = [];
    if (!closed) {
      try { await handle.close(); } catch (cause) { cleanup.push(cause); }
    }
    if (!renamed) {
      try { await unlink(temporaryFile); } catch (cause) { cleanup.push(cause); }
    }
    if (cleanup.length !== 0) {
      throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], `Atomic replacement or temporary-file cleanup failed for ${file}.`);
    }
  }
};
