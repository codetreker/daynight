import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Operation } from "../api/operation.js";
import { openRegularToolFile, withinOperation } from "./tool-io.js";

export type LauncherHost = { platform: NodeJS.Platform; arch: string; nonGlibcLinux: boolean };
export type LauncherArtifact = { role: "entry" | "shim" | "runtime" | "manifest"; path: string; parsedSha256?: string; parsedPrefix?: { bytes: number; sha256: string } };
export type IdentifiedToolLauncher = { executablePath: string; interpreterRequired: boolean; artifacts: LauncherArtifact[]; nodeArgs?: string[] };

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

const matchesBin = async (pkg: Package, entry: string, tool: Tool, operation: Operation) => {
  const bin = pkg.value.bin;
  const target = typeof bin === "string" ? bin : bin !== null && typeof bin === "object" && !Array.isArray(bin) ? (bin as Record<string, unknown>)[tool] : undefined;
  if (typeof target !== "string") return false;
  const resolved = path.resolve(pkg.root, target);
  if (!inside(pkg.root, resolved)) return false;
  try { return await withinOperation(realpath(resolved), operation) === entry; }
  catch (error) { if (missing(error)) return false; throw error; }
};

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
const platformPackage = async (pkg: Package, name: string, operation: Operation, origin = pkg.manifestPath, noGlobals = false): Promise<Package | undefined> => {
  const allowed = dependencyDirectories(pkg.root, origin);
  const directories = noGlobals ? ancestorNodeModules(origin) : createRequire(origin).resolve.paths(name) ?? [];
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

// Whole-loader registration prevents an unknown selector from launching an unrecorded binary.
// The complete official release fixtures and their provenance live in test/platform/fixtures/tool-launchers.
const codexLoaders = new Set([
  "d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406", // 0.142.5
  "134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477", // 0.145.0
  "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70", // 0.156.1
]);
// Node options from the environment must not add global packages or change canonical package resolution.
const codexNodeArgs = ["--no-global-search-paths", "--no-preserve-symlinks", "--no-preserve-symlinks-main"];
const codexTarget = (host?: LauncherHost) => {
  const platform = host?.platform ?? process.platform, arch = host?.arch ?? process.arch;
  const architecture = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  const target = platform === "linux" || platform === "android" ? "unknown-linux-musl" : platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : undefined;
  if (!architecture || !target) throw missingRuntime(`${platform}/${arch}`);
  return { triple: `${architecture}-${target}`, name: `@openai/codex-${platform === "android" ? "linux" : platform}-${arch}`, file: platform === "win32" ? "codex.exe" : "codex" };
};
const resolveCodex = async (pkg: Package, entry: string, loaderDigest: string, operation: Operation, host?: LauncherHost): Promise<LauncherArtifact[]> => {
  if (!codexLoaders.has(loaderDigest) || path.dirname(entry) !== path.join(pkg.root, "bin")) throw unsupported(entry);
  const target = codexTarget(host), selected = await platformPackage(pkg, target.name, operation, entry, true);
  if (selected && (selected.value.name !== "@openai/codex" && selected.value.name !== target.name || selected.value.exports !== undefined)) throw unsupported(selected.manifestPath);
  if (selected && path.dirname(await withinOperation(realpath(selected.manifestPath), operation)) !== await withinOperation(realpath(selected.root), operation)) throw unsupported(selected.manifestPath);
  const runtime = path.join(selected?.root ?? pkg.root, "vendor", target.triple, "bin", target.file);
  const parsedPrefix = await assertNative(runtime, operation);
  return [...(selected ? [selected.artifact] : []), { role: "runtime", path: runtime, parsedPrefix }];
};

/*
 * npm cmd-shim 8.0.0 templates, licensed under the ISC License.
 * Copyright (c) npm, Inc. and Contributors
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
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
const cmdTemplate = (target: string) => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, "",
].join("\n");
const posixTemplate = (target: string) => [
  "#!/bin/sh", 'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")', "", "case `uname` in", "    *CYGWIN*|*MINGW*|*MSYS*)",
  "        if command -v cygpath > /dev/null 2>&1; then", '            basedir=`cygpath -w "$basedir"`', "        fi", "    ;;", "esac", "",
  'if [ -x "$basedir/node" ]; then', `  exec "$basedir/node"  "$basedir/${target}" "$@"`, "else ", `  exec node  "$basedir/${target}" "$@"`, "fi", "",
].join("\n");
const powershellTemplate = (target: string) => [
  "#!/usr/bin/env pwsh", "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent", "", '$exe=""', 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  "  # Fix case when both the Windows and Linux builds of Node", "  # are installed in the same directory", '  $exe=".exe"', "}", "$ret=0",
  'if (Test-Path "$basedir/node$exe") {', "  # Support pipeline input", "  if ($MyInvocation.ExpectingInput) {",
  `    $input | & "$basedir/node$exe"  "$basedir/${target}" $args`, "  } else {", `    & "$basedir/node$exe"  "$basedir/${target}" $args`, "  }", "  $ret=$LASTEXITCODE", "} else {",
  "  # Support pipeline input", "  if ($MyInvocation.ExpectingInput) {", `    $input | & "node$exe"  "$basedir/${target}" $args`, "  } else {", `    & "node$exe"  "$basedir/${target}" $args`, "  }", "  $ret=$LASTEXITCODE", "}", "exit $ret", "",
].join("\n");

const unwrapShim = (entry: string, bytes: Buffer): string => {
  const extension = path.extname(entry).toLowerCase();
  const template = extension === ".cmd" ? cmdTemplate : extension === ".ps1" ? powershellTemplate : posixTemplate;
  const text = bytes.toString("utf8").replaceAll("\r\n", "\n");
  const prefix = template("\0").split("\0", 1)[0]!;
  if (!text.startsWith(prefix)) throw unsupported(entry);
  const end = text.indexOf('"', prefix.length);
  if (end === -1) throw unsupported(entry);
  const target = text.slice(prefix.length, end);
  // Parsing must use the same bounded bytes as the digest, without reopening the pathname.
  if (!target || text !== template(target)) throw unsupported(entry);
  const normalized = target.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(target) || /[\0\r\n]/.test(target)) throw unsupported(entry);
  return path.resolve(path.dirname(entry), ...normalized.split("/"));
};

/** Analyze only known launchers. No selected package's JavaScript or shell wrapper is executed. */
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
  const pkg = await owningPackage(entry, operation);
  const officialName = tool === "codex" ? "@openai/codex" : tool === "copilot" ? "@github/copilot" : undefined;
  const official = officialName !== undefined && pkg?.value.name === officialName;
  if (shim && !official || official && !await matchesBin(pkg!, entry, tool, operation)) throw unsupported(entryPath);
  const entryArtifact: LauncherArtifact = { role: "entry", path: artifactPath, parsedPrefix: { bytes: header.length, sha256: digest(header) } };
  artifacts.push(entryArtifact);
  if (official) {
    const bytes = await read(entry, operation); entryArtifact.parsedSha256 = digest(bytes);
    artifacts.push(pkg!.artifact);
    if (tool === "copilot") {
      const selected = await resolveCopilot(pkg!, operation, host);
      return { executablePath: selected.executablePath, interpreterRequired: false, artifacts: [...artifacts, ...selected.artifacts] };
    }
    artifacts.push(...await resolveCodex(pkg!, entry, entryArtifact.parsedSha256, operation, host));
  }
  return { executablePath: entry, interpreterRequired: true, artifacts, ...(official && tool === "codex" ? { nodeArgs: [...codexNodeArgs] } : {}) };
};
