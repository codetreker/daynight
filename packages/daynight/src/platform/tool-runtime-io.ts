import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { Operation } from "../api/operation.js";
import { withinOperation } from "./tool-io.js";

/** Read bounded runtime metadata without following a swapped symlink or blocking on a FIFO. */
export async function readToolRuntimeText(file: string, operation: Operation, options: { limit: number; private?: boolean | "owner" }): Promise<string> {
  operation.check();
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const handle = await withinOperation(open(file, flags), operation, late => late.close());
  const invalid = () => Object.assign(new Error("Runtime metadata must be a stable bounded regular file."), { code: "not_executable" });
  try {
    const before = await withinOperation(handle.stat({ bigint: true }), operation);
    if (!before.isFile() || before.size > BigInt(options.limit) || await withinOperation(realpath(file), operation) !== file
      || options.private && process.platform !== "win32" && (before.uid !== BigInt(process.geteuid!())
        || (options.private === "owner" ? (before.mode & 0o077n) !== 0n : (before.mode & 0o777n) !== 0o600n))) throw invalid();
    const signature = (info: typeof before) => [info.dev, info.ino, info.mode, info.uid, info.gid, info.size, info.mtimeNs, info.ctimeNs].join(":");
    const buffer = Buffer.alloc(options.limit + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await withinOperation(handle.read(buffer, length, buffer.length - length, length), operation);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > options.limit || signature(before) !== signature(await withinOperation(handle.stat({ bigint: true }), operation))
      || signature(before) !== signature(await withinOperation(lstat(file, { bigint: true }), operation)) || await withinOperation(realpath(file), operation) !== file) throw invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await withinOperation(handle.close(), operation); }
}
