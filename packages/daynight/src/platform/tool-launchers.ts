import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Operation } from "../api/operation.js";
import { openRegularToolFile, withinOperation } from "./tool-io.js";

export type LauncherHost = { platform: NodeJS.Platform; arch: string; nonGlibcLinux: boolean };
export type LauncherArtifact = { role: "entry" | "shim" | "runtime" | "manifest"; path: string; parsedSha256?: string; parsedPrefix?: { bytes: number; sha256: string } };
export type IdentifiedToolLauncher = { executablePath: string; interpreterRequired: boolean; artifacts: LauncherArtifact[] };

export class LauncherError extends Error {
  constructor(readonly code: "unsupported_launcher" | "incompatible_runtime" | "not_executable", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "LauncherError";
  }
}
const unsupported = (file: string) => new LauncherError("unsupported_launcher", `Unsupported tool launcher: ${file}. Specify its native executable or a supported Node entry.`);
const missingRuntime = (file: string, cause?: unknown) => new LauncherError("incompatible_runtime", `The selected tool installation has no supported runtime: ${file}.`, { cause });
const missing = (error: unknown) => error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadataLimit = 1024 * 1024;
const prefixLimit = 4096;
type Tool = "codex" | "copilot" | "herdr";
type Package = { root: string; manifestPath: string; value: Record<string, unknown>; artifact: LauncherArtifact };

const read = async (file: string, operation: Operation, prefix = false): Promise<Buffer> => {
  operation.check();
  const handle = await openRegularToolFile(file, operation);
  try {
    const info = await withinOperation(handle.stat(), operation);
    if (!info.isFile()) throw new LauncherError("not_executable", `Tool entry is not a regular file: ${file}.`);
    const limit = prefix ? prefixLimit : metadataLimit;
    if (!prefix && info.size > limit) throw unsupported(file);
    const bytes = Buffer.alloc(prefix ? limit : limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await withinOperation(handle.read(bytes, length, bytes.length - length, length), operation);
      if (bytesRead === 0) break;
      operation.consume(bytesRead); length += bytesRead;
    }
    if (!prefix && length > limit) throw unsupported(file);
    return bytes.subarray(0, length);
  } finally { await withinOperation(handle.close(), operation); }
};

const readPackage = async (manifestPath: string, operation: Operation): Promise<Package> => {
  const bytes = await read(manifestPath, operation);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw unsupported(manifestPath); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unsupported(manifestPath);
  return { root: path.dirname(manifestPath), manifestPath, value: value as Record<string, unknown>, artifact: { role: "manifest", path: manifestPath, parsedSha256: digest(bytes) } };
};

const packageAt = async (directory: string, operation: Operation): Promise<Package | undefined> => {
  const manifestPath = path.join(directory, "package.json");
  try { await withinOperation(stat(manifestPath), operation); } catch (error) { if (missing(error)) return undefined; throw error; }
  return readPackage(manifestPath, operation);
};

const owningPackage = async (entry: string, operation: Operation): Promise<Package | undefined> => {
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    const found = await packageAt(directory, operation);
    if (found) return found;
    if (path.dirname(directory) === directory) return undefined;
  }
};

const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

const ancestorNodeModules = (origin: string): string[] => {
  const result: string[] = [];
  for (let directory = path.dirname(origin); ; directory = path.dirname(directory)) {
    if (path.basename(directory) !== "node_modules") result.push(path.join(directory, "node_modules"));
    if (path.dirname(directory) === directory) return result;
  }
};
const dependencyDirectories = (packageRoot: string, origin: string) => {
  let owner: string | undefined;
  for (let directory = path.dirname(packageRoot); ; directory = path.dirname(directory)) {
    if (path.basename(directory) === "node_modules") { owner = directory; break; }
    if (path.dirname(directory) === directory) break;
  }
  return ancestorNodeModules(origin).filter(directory => inside(packageRoot, directory) || owner !== undefined && (directory === owner || inside(owner, directory)));
};

/** Search in Node order, but never borrow a missing platform package from another installation. */
const platformPackage = async (pkg: Package, name: string, operation: Operation, origin = pkg.manifestPath): Promise<Package | undefined> => {
  const allowed = dependencyDirectories(pkg.root, origin);
  const directories = createRequire(origin).resolve.paths(name) ?? [];
  for (const directory of directories) {
    const packageRoot = path.join(directory, name);
    try { await withinOperation(stat(packageRoot), operation); } catch (error) { if (missing(error)) continue; throw error; }
    if (!allowed.includes(directory)) throw unsupported(packageRoot);
    // Keep this lexical dependency path: pnpm symlinks are part of the frozen selection.
    const found = await packageAt(packageRoot, operation);
    if (!found) throw unsupported(packageRoot);
    return found;
  }
  return undefined;
};

const nativeHeader = (bytes: Buffer) => bytes.length >= 4 && (
  bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
  bytes.subarray(0, 2).equals(Buffer.from("MZ")) ||
  [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE(0))
);
const assertNative = async (file: string, operation: Operation) => {
  try {
    const bytes = await read(file, operation, true);
    if (!nativeHeader(bytes)) throw unsupported(file);
    return { bytes: bytes.length, sha256: digest(bytes) };
  }
  catch (error) { if (missing(error)) throw missingRuntime(file, error); throw error; }
};

const bundledManifest = (): string => createRequire(import.meta.url).resolve("@github/copilot/package.json");
export const bundledCopilotEntry = (): string => path.join(path.dirname(bundledManifest()), "npm-loader.js");
const copilotPlatforms = (host?: LauncherHost): string[] => {
  const platform = host?.platform ?? process.platform;
  if (platform !== "linux") return [platform];
  const nonGlibc = host?.nonGlibcLinux ?? (createRequire(bundledManifest())("detect-libc") as { isNonGlibcLinuxSync(): boolean }).isNonGlibcLinuxSync();
  return nonGlibc ? ["linuxmusl", "linux"] : ["linux"];
};

const interpreterLibc = (bytes: Buffer): boolean | undefined => {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) return undefined;
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size < 56 || offset + size * count > bytes.length) return undefined;
  for (let index = 0; index < count; index++) {
    const header = offset + size * index;
    if (bytes.readUInt32LE(header) !== 3) continue;
    const start = Number(bytes.readBigUInt64LE(header + 8)), length = Number(bytes.readBigUInt64LE(header + 32));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start + length > bytes.length) return undefined;
    const interpreter = bytes.subarray(start, start + length).toString("utf8");
    return interpreter.includes("/ld-musl-") ? true : interpreter.includes("/ld-linux-") ? false : undefined;
  }
  return undefined;
};

// Match detect-libc's interpreter/ldd/report evidence without its unbounded shell-command fallback.
const nonGlibcLinux = async (operation: Operation): Promise<boolean> => {
  const interpreter = interpreterLibc(await read(process.execPath, operation, true));
  if (interpreter !== undefined) return interpreter;
  try {
    const ldd = (await read("/usr/bin/ldd", operation, true)).toString("utf8");
    if (ldd.includes("musl")) return true;
    if (ldd.includes("GNU C Library")) return false;
  } catch (error) { if (!missing(error)) throw error; }
  operation.check();
  const report = process.report.getReport() as unknown as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] };
  operation.check();
  if (report.header?.glibcVersionRuntime) return false;
  if (report.sharedObjects?.some(file => file.includes("libc.musl-") || file.includes("ld-musl-"))) return true;
  throw missingRuntime("Linux libc");
};

/** Preserve standalone Controller callers' synchronous bundled-runtime selection. */
export const copilotExecutable = (): string => {
  const require = createRequire(bundledManifest());
  for (const platform of copilotPlatforms()) try { return require.resolve(`@github/copilot-${platform}-${process.arch}`); } catch { /* Try the CLI's supported platform fallback. */ }
  throw new Error("The installed Copilot CLI has no native package for this platform.");
};

const resolveCopilot = async (pkg: Package, operation: Operation, host?: LauncherHost): Promise<{ executablePath: string; artifacts: LauncherArtifact[] }> => {
  const system = host?.platform ?? process.platform;
  const platforms = system === "linux" && (host?.nonGlibcLinux ?? await nonGlibcLinux(operation)) ? ["linuxmusl", "linux"] : [system];
  for (const platform of platforms) {
    const name = `@github/copilot-${platform}-${host?.arch ?? process.arch}`;
    const selected = await platformPackage(pkg, name, operation);
    if (!selected) continue;
    const exports = selected.value.exports;
    const target = typeof exports === "string" ? exports : exports !== null && typeof exports === "object" && !Array.isArray(exports) ? (exports as Record<string, unknown>)["."] : undefined;
    const expected = platform === "win32" ? "./copilot.exe" : "./copilot";
    if (selected.value.name !== name || target !== expected) throw unsupported(selected.manifestPath);
    const runtime = path.join(selected.root, expected);
    const parsedPrefix = await assertNative(runtime, operation);
    return { executablePath: await withinOperation(realpath(runtime), operation), artifacts: [selected.artifact, { role: "runtime", path: runtime, parsedPrefix }] };
  }
  throw missingRuntime(pkg.manifestPath);
};

/* Target extraction patterns adapted from read-cmd-shim 6.0.0.
 * Copyright (c) 2015, Rebecca Turner <me@re-becca.org>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
const unwrapShim = (entry: string, bytes: Buffer): string => {
  const extension = path.extname(entry).toLowerCase();
  // Extract from the bounded snapshot, without opening the pathname again or
  // executing any of the wrapper's shell text.
  const text = bytes.toString("utf8");
  const match = extension === ".cmd" ? text.match(/"%(?:~dp0|dp0%)\\([^"]+?)"\s+%\*/)
    : extension === ".ps1" ? text.match(/"\$basedir\/([^"]+?)"\s+\$args/)
      : text.match(/"\$basedir\/([^"]+?)"\s+"\$@"/);
  const target = match?.[1];
  if (!target) throw unsupported(entry);
  const normalized = target.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(target) || /[\0\r\n]/.test(target)) throw unsupported(entry);
  return path.resolve(path.dirname(entry), ...normalized.split("/"));
};

/** Identify native and Node entries without executing the selected wrapper. */
export const identifyToolLauncher = async (entryPath: string, tool: Tool, operation: Operation, host?: LauncherHost): Promise<IdentifiedToolLauncher> => {
  const artifacts: LauncherArtifact[] = [];
  let entry = await withinOperation(realpath(entryPath), operation);
  let header = await read(entryPath, operation, true);
  if (nativeHeader(header)) return { executablePath: entry, interpreterRequired: false, artifacts: [{ role: "entry", path: entryPath, parsedPrefix: { bytes: header.length, sha256: digest(header) } }] };
  const shim = /\.(cmd|ps1)$/i.test(entry) || /^#!\s*\/bin\/sh(?:\r?\n|$)/.test(header.toString("utf8"));
  let artifactPath = entryPath;
  if (shim) {
    const bytes = await read(entryPath, operation);
    artifactPath = unwrapShim(entryPath, bytes);
    artifacts.push({ role: "shim", path: entryPath, parsedSha256: digest(bytes) });
    entry = await withinOperation(realpath(artifactPath), operation);
    header = await read(artifactPath, operation, true);
  }
  const line = header.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  if (line.startsWith("#!") && header.length === prefixLimit && !header.includes(10)) throw unsupported(entryPath);
  const nodeShebang = /^#![ \t]*(?:\/usr\/bin\/env[ \t]+node|(?:\/[^\s]+\/)?node(?:\.exe)?)[ \t]*$/.test(line);
  if (line.startsWith("#!") ? !nodeShebang : !/\.[cm]?js$/i.test(entry)) throw unsupported(entryPath);
  const entryArtifact: LauncherArtifact = { role: "entry", path: artifactPath, parsedPrefix: { bytes: header.length, sha256: digest(header) } };
  artifacts.push(entryArtifact);
  if (tool === "copilot") {
    const pkg = await owningPackage(entry, operation);
    if (pkg?.value.name === "@github/copilot") {
      const bytes = await read(entry, operation); entryArtifact.parsedSha256 = digest(bytes);
      artifacts.push(pkg.artifact);
      const selected = await resolveCopilot(pkg, operation, host);
      return { executablePath: selected.executablePath, interpreterRequired: false, artifacts: [...artifacts, ...selected.artifacts] };
    }
  }
  return { executablePath: entry, interpreterRequired: true, artifacts };
};
