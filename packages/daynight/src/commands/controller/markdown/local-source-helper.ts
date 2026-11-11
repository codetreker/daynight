import { constants, closeSync, fstatSync, lstatSync, realpathSync, openSync, readSync, writeSync, fsyncSync } from "node:fs";
import { createHash } from "node:crypto";
import * as koffi from "koffi";
import type { LocalImageCheckpoint, LocalImageObjectIdentity, LocalImageSourceProof, LocalImageTraversalStep } from "./local-source-proof.js";

const { isSupportedLocalImageFilesystem }: typeof import("./local-source-filesystem.js") = await import(new URL(`./local-source-filesystem.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href);
const { LocalImageTraversal, parseLocalImageCheckpoint }: typeof import("./local-source-proof.js") = await import(new URL(`./local-source-proof.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href);

const darwin = process.platform === "darwin";
const library = koffi.load(darwin ? "libSystem.B.dylib" : "libc.so.6");
const openat = library.func("int openat(int fd, const char *path, int flags, int mode)");
// Intel macOS keeps legacy 32-bit-inode symbols alongside the current ABI.
const inodeSuffix = darwin && process.arch === "x64" ? "$INODE64" : "";
const fstatfs = library.func(`fstatfs${inodeSuffix}`, "int", ["int", "void *"]);
const fstatat = library.func(`fstatat${inodeSuffix}`, "int", ["int", "str", "void *", "int"]);
const readlinkat = library.func("intptr_t readlinkat(int fd, const char *path, void *buffer, size_t size)");
const errno = library.func(darwin ? "int *__error(void)" : "int *__errno_location(void)");
const limit = 10_485_760, chunkSize = 524_288;
const nofollow = constants.O_NOFOLLOW, nonblock = constants.O_NONBLOCK;
function sourceError(code: string): never { throw Object.assign(new Error("Local image source is unavailable."), { code }); }
const nativeError = (): never => {
  const code = koffi.decode(errno(), "int") as number;
  return sourceError(code === 2 ? "source_not_found" : [1, 13].includes(code) ? "permission_denied" : code === 40 || code === 62 ? "source_forbidden" : "source_unavailable");
};
const openRelative = (parent: number, name: string, directory: boolean): number => {
  const fd = openat(parent, name, constants.O_RDONLY | nonblock | nofollow | (directory ? constants.O_DIRECTORY : 0), 0) as number;
  if (fd < 0) nativeError(); return fd;
};
const safeFs = (fd: number): void => {
  const info = Buffer.alloc(4096);
  if ((fstatfs(fd, info) as number) !== 0) nativeError();
  // Network filesystems and userspace mounts do not provide the required local
  // object semantics. Unknown filesystem types are deliberately fail closed.
  if (!isSupportedLocalImageFilesystem(info, process.platform)) sourceError("policy_restricted");
};
const identity = (stat: { dev: number | bigint; ino: number | bigint }): string => `${stat.dev}:${stat.ino}`;
const objectIdentity = (value: string): LocalImageObjectIdentity => { const [dev, ino] = value.split(":"); return { kind: "posix", dev: dev!, ino: ino! }; };
const heldIdentity = (fd: number): LocalImageObjectIdentity => objectIdentity(identity(fstatSync(fd, { bigint: true })));
const snapshot = (fd: number): string => {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
};
const statAt = (parent: number, name: string): { symlink: boolean; identity: string; object: string } => {
  if (!["arm64", "x64"].includes(process.arch)) sourceError("policy_restricted");
  const bytes = Buffer.alloc(512);
  if ((fstatat(parent, name, bytes, darwin ? 0x20 : 0x100) as number) !== 0) nativeError();
  // These are the stable stat ABI fields for macOS stat64 and Linux stat on
  // x86_64/aarch64. Exclude atime because readlink itself can update it.
  const mode = darwin ? bytes.readUInt16LE(4) : bytes.readUInt32LE(process.arch === "x64" ? 24 : 16);
  const key = darwin ? Buffer.concat([bytes.subarray(0, 6), bytes.subarray(8, 16), bytes.subarray(48, 80), bytes.subarray(96, 104)]) : Buffer.concat([bytes.subarray(0, 16), bytes.subarray(48, 56), bytes.subarray(88, 120)]);
  const dev = darwin ? BigInt(bytes.readUInt32LE(0)) : bytes.readBigUInt64LE(0);
  return { symlink: (mode & 0xf000) === 0xa000, identity: key.toString("hex"), object: `${dev}:${bytes.readBigUInt64LE(8)}` };
};
let root = -1, cwd = "", requestedCwd = "", physicalCwd = "", rootIdentity = "", active = false;
const post = (message: object): void => { if (process.connected) process.send!(message); };
const rootValid = (): void => {
  for (const rootPath of new Set([cwd, physicalCwd])) {
    const visible = lstatSync(rootPath, { bigint: true });
    if (!visible.isDirectory() || visible.isSymbolicLink() || identity(visible) !== rootIdentity) sourceError("source_forbidden");
  }
};
const absoluteParts = (value: string): string[] => {
  for (const candidate of new Set([cwd, physicalCwd])) {
    const prefix = candidate === "/" ? "/" : `${candidate.replace(/\/$/, "")}/`;
    if (value.startsWith(prefix)) return value.slice(prefix.length).split("/");
  }
  return sourceError("source_forbidden");
};
const resolveSource = (value: string): { fd: number; held: number[]; traversal: LocalImageTraversalStep[] } => {
  rootValid();
  const held: number[] = [];
  const stack = [root];
  const traversal = new LocalImageTraversal();
  let parts = value.startsWith("/") ? absoluteParts(value) : value.split("/"), links = 0, steps = 0;
  try {
    while (parts.length) {
      if (++steps > 8192 || held.length > 4096) sourceError("source_forbidden");
      const component = parts.shift()!;
      if (!component || component === ".") continue;
      if (component === "..") { if (stack.length === 1) sourceError("source_forbidden"); const from = stack.pop()!; traversal.push({ kind: "parent", from: heldIdentity(from), to: heldIdentity(stack.at(-1)!) }); continue; }
      const parent = stack.at(-1)!;
      const before = statAt(parent, component);
      if (before.symlink) {
        if (++links > 40) sourceError("source_forbidden");
        const bytes = Buffer.alloc(8193), count = Number(readlinkat(parent, component, bytes, bytes.length));
        if (count < 0) nativeError();
        if (!count || count > 8192) sourceError("source_forbidden");
        const target = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
        if (/\p{Cc}/u.test(target) || !target.isWellFormed() || statAt(parent, component).identity !== before.identity) sourceError("source_changed");
        traversal.push({ kind: "link", parent: heldIdentity(parent), name: component, object: objectIdentity(before.object), target, relative: !target.startsWith("/") });
        if (target.startsWith("/")) { stack.length = 1; parts = [...absoluteParts(target), ...parts]; }
        else parts = [...target.split("/"), ...parts];
        continue;
      }
      const directory = parts.some(part => part !== "" && part !== ".");
      const fd = openRelative(parent, component, directory); held.push(fd); safeFs(fd);
      const stat = fstatSync(fd, { bigint: true });
      traversal.push({ kind: "open", parent: heldIdentity(parent), name: component, object: objectIdentity(identity(stat)), directory: stat.isDirectory() });
      if (directory) { if (!stat.isDirectory()) sourceError("source_forbidden"); stack.push(fd); }
      else { if (!stat.isFile()) sourceError("source_forbidden"); rootValid(); return { fd, held, traversal: traversal.steps }; }
    }
    sourceError("source_forbidden");
  } catch (error) { for (const fd of held.reverse()) closeSync(fd); throw error; }
};
let continueRead: (() => void) | undefined;
const checkpoint = async (stage: LocalImageCheckpoint["stage"], proof: LocalImageSourceProof): Promise<void> => {
  const checked = parseLocalImageCheckpoint({ stage, proof });
  await new Promise<void>(resolve => { continueRead = resolve; post({ type: "checkpoint", ...checked }); });
};
const copy = async (locator: string, value: string, outputPath: string): Promise<{ byteLength: number; sha256: string }> => {
  const handles: number[] = [];
  try {
    const initialProof: LocalImageSourceProof = { requested: { locator, path: value }, root: { cwd: requestedCwd, identity: heldIdentity(root), traversal: [] }, traversal: [], opened: null };
    await checkpoint("initial", initialProof); rootValid();
    const source = resolveSource(value); handles.push(...source.held);
    const initial = fstatSync(source.fd, { bigint: true }), before = snapshot(source.fd);
    if (initial.size === 0n) sourceError("source_unavailable");
    if (initial.size > BigInt(limit)) sourceError("source_too_large");
    const proof: LocalImageSourceProof = { ...initialProof, traversal: source.traversal, opened: objectIdentity(identity(initial)) };
    // The reservation owns creation and cleanup; this reader never creates,
    // truncates or changes permissions on any filesystem object.
    const output = openSync(outputPath, constants.O_WRONLY | nonblock | nofollow); handles.push(output);
    const outputBefore = fstatSync(output, { bigint: true });
    if (!outputBefore.isFile() || outputBefore.size !== 0n || outputBefore.nlink !== 1n || outputBefore.uid !== BigInt(process.getuid!()) || (outputBefore.mode & 0o777n) !== 0o600n || identity(outputBefore) === identity(initial)) sourceError("source_forbidden");
    safeFs(output); await checkpoint("opened", proof);
    const bytes = Buffer.alloc(chunkSize), hash = createHash("sha256"); let total = 0;
    for (;;) {
      const count = readSync(source.fd, bytes, 0, Math.min(chunkSize, limit + 1 - total), null);
      if (!count) break;
      if (total + count > limit) sourceError("source_too_large");
      await checkpoint("block", proof); rootValid();
      let written = 0;
      while (written < count) {
        const countWritten = writeSync(output, bytes, written, count - written, null);
        if (countWritten <= 0) sourceError("source_unavailable");
        written += countWritten;
      }
      hash.update(bytes.subarray(0, count)); total += count;
    }
    if (snapshot(source.fd) !== before || BigInt(total) !== initial.size) sourceError("source_changed");
    await checkpoint("final", proof); rootValid();
    if (snapshot(source.fd) !== before) sourceError("source_changed");
    const visibleOutput = lstatSync(outputPath, { bigint: true }), outputAfter = fstatSync(output, { bigint: true });
    if (!visibleOutput.isFile() || identity(visibleOutput) !== identity(outputBefore) || identity(outputAfter) !== identity(outputBefore) || outputAfter.size !== BigInt(total) || outputAfter.nlink !== 1n) sourceError("source_changed");
    fsyncSync(output); return { byteLength: total, sha256: hash.digest("hex") };
  } finally { for (const fd of handles.reverse()) closeSync(fd); }
};
process.on("message", (message: { type: string; cwd?: string; locator?: string; path?: string; outputPath?: string; expectedRoot?: { dev: string; ino: string } }) => {
  if (message.type === "continue") { const resume = continueRead; continueRead = undefined; resume?.(); return; }
  if (message.type === "init") {
    try {
      cwd = requestedCwd = message.cwd!;
      if (cwd.length > 1 && cwd.endsWith("/")) cwd = cwd.slice(0, -1);
      root = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY | nofollow | nonblock); safeFs(root);
      const stat = fstatSync(root, { bigint: true }); if (!stat.isDirectory()) sourceError("context_unavailable"); rootIdentity = identity(stat);
      if (message.expectedRoot && rootIdentity !== `${message.expectedRoot.dev}:${message.expectedRoot.ino}`) sourceError("source_forbidden");
      if (statAt(root, ".").object !== rootIdentity) sourceError("policy_restricted");
      // A physical spelling is only a candidate root alias, verified against the
      // already-held object. It never supplies a pathname for opening source bytes.
      physicalCwd = realpathSync(cwd); rootValid(); post({ type: "ready" });
    } catch (error) { post({ type: "error", code: (error as { code?: string }).code ?? "context_unavailable" }); process.disconnect(); }
  } else if (message.type === "copy" && !active && root >= 0) {
    active = true;
    void copy(message.locator!, message.path!, message.outputPath!).then(result => post({ type: "result", ...result }), error => {
      const code = (error as { code?: string }).code;
      post({ type: "error", code: code === "ENOENT" ? "source_not_found" : code === "EACCES" || code === "EPERM" ? "permission_denied" : code === "ELOOP" ? "source_forbidden" : code === "ENOSPC" ? "source_capacity" : typeof code === "string" && ["source_not_found", "source_forbidden", "source_changed", "source_too_large", "source_capacity", "policy_restricted", "source_unavailable"].includes(code) ? code : "source_unavailable" });
    }).finally(() => { active = false; });
  }
});
process.on("disconnect", () => { if (root >= 0) closeSync(root); process.exit(0); });
