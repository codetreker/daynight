import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const invalid = (): never => { throw new Error("Cannot establish the complete worktree mount inventory."); };
const decoder = new TextDecoder("utf-8", { fatal: true });
const mountPath = (value: string): string => {
  if (!value.startsWith("/") || value.includes("\0") || path.posix.normalize(value) !== value) return invalid();
  return value;
};

// Linux exposes paths as bytes, escaping whitespace and backslash in mountinfo.
export const parseLinuxMountInfo = (bytes: Uint8Array): readonly string[] => {
  const text = decoder.decode(bytes);
  if (text === "" || !text.endsWith("\n")) return invalid();
  return text.slice(0, -1).split("\n").map(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    if (fields.length < 10 || separator < 6 || separator + 4 !== fields.length || fields.some(field => field === "")
      || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!) || !/^\d+:\d+$/.test(fields[2]!)) return invalid();
    const raw = fields[4]!;
    if (/\\(?!040|011|012|134)/.test(raw)) return invalid();
    return mountPath(raw.replace(/\\(040|011|012|134)/g, (_, value: string) => ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[value]!));
  });
};

const macMounts = async (): Promise<readonly string[]> => {
  const koffi = await import("koffi"), library = koffi.load("/usr/lib/libSystem.B.dylib");
  // Darwin's 64-bit struct statfs, defined in sys/mount.h.
  const statfs = koffi.struct({
    bsize: "uint32_t", iosize: "int32_t", blocks: "uint64_t", bfree: "uint64_t", bavail: "uint64_t", files: "uint64_t", ffree: "uint64_t",
    fsid: koffi.array("int32_t", 2), owner: "uint32_t", type: "uint32_t", flags: "uint32_t", subtype: "uint32_t",
    typename: koffi.array("uint8_t", 16), mountpoint: koffi.array("uint8_t", 1024), from: koffi.array("uint8_t", 1024),
    flagsExt: "uint32_t", reserved: koffi.array("uint32_t", 7),
  });
  const size = koffi.sizeof(statfs), offset = koffi.offsetof(statfs, "mountpoint");
  if (size !== 2168 || offset !== 88) return invalid();
  if (process.arch !== "arm64" && process.arch !== "x64") return invalid();
  const getfsstat = library.func(process.arch === "x64" ? "getfsstat$INODE64" : "getfsstat", "int", ["void *", "int", "int"]);
  const count = getfsstat(null, 0, 2) as number;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) return invalid();
  const capacity = count + 32, buffer = Buffer.alloc(capacity * size), received = getfsstat(buffer, buffer.length, 2) as number;
  if (!Number.isSafeInteger(received) || received < 1 || received >= capacity) return invalid();
  const mounts: string[] = [];
  for (let index = 0; index < received; index++) {
    const name = buffer.subarray(index * size + offset, index * size + offset + 1024), end = name.indexOf(0);
    if (end <= 0) return invalid();
    mounts.push(mountPath(decoder.decode(name.subarray(0, end))));
  }
  return mounts;
};

export const assertMountPathsOutsideWorktree = (target: string, mounts: readonly string[]): void => {
  for (const mount of mounts) {
    const relative = path.posix.relative(target, mount);
    if (relative === "" || relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative)) throw new Error(`Worktree contains a mounted filesystem: ${mount}`);
  }
};

/** Reject a mounted target or any mounted descendant before privileged removal. */
export const assertNoWorktreeMounts = async (physicalPath: string, platform: NodeJS.Platform = process.platform): Promise<void> => {
  const target = mountPath(physicalPath);
  const mounts = platform === "linux" ? parseLinuxMountInfo(await readFile("/proc/self/mountinfo"))
    : platform === "darwin" ? await macMounts() : invalid();
  const mounted = (mount: string): never => { throw new Error(`Worktree contains a mounted filesystem: ${mount}`); };
  assertMountPathsOutsideWorktree(target, mounts);
  if (platform === "darwin") {
    // Firmlinks may expose a mountpoint under another spelling of the same directory.
    const targetInfo = await stat(target, { bigint: true });
    const seen = new Map<string, Promise<{ dev: bigint; ino: bigint }>>();
    for (const mount of mounts) {
      let current = mount;
      for (;;) {
        let pending = seen.get(current);
        if (pending === undefined) { pending = stat(current, { bigint: true }); seen.set(current, pending); }
        const info = await pending;
        if (info.dev === targetInfo.dev && info.ino === targetInfo.ino) mounted(mount);
        if (current === "/") break;
        current = path.posix.dirname(current);
      }
    }
  }
};
