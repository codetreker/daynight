import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Operation } from "../api/operation.js";
import { fingerprintToolArtifact, verifyToolLaunch, type ResolvedToolLaunch, type ToolArtifact } from "./tool-executables.js";
import { parseResolvedToolLaunch } from "./tool-launch-record.js";
import { withinOperation } from "./tool-io.js";
import { readToolRuntimeText } from "./tool-runtime-io.js";

export const copilotRuntimeCatalogue = Object.freeze({
  kind: "copilot-read-authority-v1" as const,
  sdkVersion: "1.0.11" as const,
  authorityProtocol: "daynight.copilot.read.v1" as const,
  executable: "5fd7d15ff02deb08a58593b1b488015bb52c1686014b80b5509e28263cb3ad70",
  files: {
    "index.js": "19f4cb854302397bdd880f5cde12ed069d373a630dce3f09a60e62b8ac8fcc4c",
    "cli-main.js": "8b6ce892c34775028d9f8c31e39a346e24becdd94f660a6985f8ecb53e8b3fde",
    "prebuilds/darwin-arm64/runtime.node": "423ba722d1fa544ba352fd6e702d5b67f78419995a0247580185aa030bcbc1fb",
  },
});
export const copilotPreloadFiles = [
  "providers/copilot-read-authority-preload.js", "providers/copilot-read-authority-server.js",
  "providers/copilot-read-authority-check.js", "providers/copilot-read-authority-correlation.js",
  "providers/copilot-read-authority.js", "markdown/local-source-proof.js",
] as const;
export const runtimeTreeLimit = 536_870_912;
export const runtimeManifestLimit = 4 * 1_048_576;
const fail = (): never => { throw new Error("Copilot frozen runtime identity is invalid."); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const signature = (info: Awaited<ReturnType<typeof lstat>>) => [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
const textDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const readRuntimeText = (file: string, operation: Operation, limit = 1_048_576) => readToolRuntimeText(file, operation, { limit });
export type RuntimeTreeEntry = { path: string; type: "file" | "directory"; size: string; sha256: string | null; mode: number };
export type RuntimeManifest = { schemaVersion: 1; kind: "copilot-read-authority-v1"; materializationKey: string; entries: RuntimeTreeEntry[] };

/** This root comes from WorkerPaths, never from a ticket's self-declared root. */
export async function verifyPrivateRuntimeDirectory(directory: string, trustedRoot: string, operation: Operation): Promise<void> {
  if (!path.isAbsolute(trustedRoot) || path.normalize(trustedRoot) !== trustedRoot
    || !path.isAbsolute(directory) || path.normalize(directory) !== directory
    || directory !== trustedRoot && !directory.startsWith(`${trustedRoot}${path.sep}`)) fail();
  // Reject symlink components up to the filesystem root. Ancestors may be public;
  // the Worker runtime subtree must be private and owned by this user.
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await withinOperation(lstat(current), operation);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    if (current === trustedRoot || current.startsWith(`${trustedRoot}${path.sep}`)) {
      if (process.platform !== "win32" && ((info.mode & 0o777) !== 0o700 || typeof process.getuid === "function" && info.uid !== process.getuid())) fail();
    }
  }
}

/** Enumerate the complete immutable distribution, including empty directories. */
export async function captureRuntimeTree(directory: string, operation: Operation): Promise<RuntimeTreeEntry[]> {
  const result: RuntimeTreeEntry[] = [], aliases = new Set<string>(); let bytes = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    operation.check();
    if (depth > 32 || result.length >= 10_000) fail();
    const full = path.join(directory, relative), before = await withinOperation(lstat(full), operation);
    if (before.isSymbolicLink() || !before.isFile() && !before.isDirectory() || await withinOperation(realpath(full), operation) !== full) fail();
    if (relative !== "") {
      if (!relative.isWellFormed() || /[\\\p{Cc}]/u.test(relative) || path.posix.normalize(relative) !== relative || relative.startsWith("/")
        || relative.split("/").some(part => part === ".." || part === "." || part === "") || aliases.has(relative.toLowerCase())) fail();
      aliases.add(relative.toLowerCase());
      const artifact = before.isFile() ? await fingerprintToolArtifact({ role: "support", path: full }, operation) : undefined;
      if (before.isFile() && (bytes += before.size) > runtimeTreeLimit) fail();
      result.push({ path: relative, type: before.isFile() ? "file" : "directory", size: before.isFile() ? before.size.toString() : "0", sha256: artifact?.sha256 ?? null, mode: before.mode & 0o777 });
    }
    if (before.isDirectory()) {
      const names = (await withinOperation(readdir(full), operation)).sort(compare);
      for (const name of names) await walk(relative ? `${relative}/${name}` : name, depth + 1);
      if (JSON.stringify(names) !== JSON.stringify((await withinOperation(readdir(full), operation)).sort(compare))) fail();
    }
    if (signature(before) !== signature(await withinOperation(lstat(full), operation))) fail();
  };
  await walk("", 0); return result.sort((a, b) => compare(a.path, b.path));
}

export async function readRuntimeManifest(root: string, materializationKey: string, operation: Operation, expectedSha256?: string): Promise<RuntimeManifest> {
  const file = path.join(root, "manifest.json"), info = await withinOperation(lstat(file), operation);
  if (!info.isFile() || info.isSymbolicLink() || info.size > runtimeManifestLimit || process.platform !== "win32" && (info.mode & 0o777) !== 0o600) fail();
  const text = await readRuntimeText(file, operation, runtimeManifestLimit);
  if (expectedSha256 !== undefined && textDigest(text) !== expectedSha256) fail();
  const value = JSON.parse(text) as RuntimeManifest;
  if (!value || Object.keys(value).sort().join() !== "entries,kind,materializationKey,schemaVersion" || value.schemaVersion !== 1
    || value.kind !== copilotRuntimeCatalogue.kind || value.materializationKey !== materializationKey || !Array.isArray(value.entries)) fail();
  const names = (await withinOperation(readdir(root), operation)).sort();
  if (names.join() !== "distribution,manifest.json") fail();
  const entries = await captureRuntimeTree(path.join(root, "distribution"), operation);
  // Equality also rejects unknown fields, duplicates, malformed paths and limits.
  if (JSON.stringify(value.entries) !== JSON.stringify(entries)) fail();
  return value;
}

const canonicalArtifacts = (artifacts: readonly ToolArtifact[]) => artifacts.map(({ role, realPath, size, sha256 }) => ({ role, realPath, size, sha256 }))
  .sort((a, b) => compare(a.role, b.role) || compare(a.realPath, b.realPath));
export const copilotMaterializationKey = (source: ResolvedToolLaunch, support: readonly ToolArtifact[]): string => hash({
  kind: copilotRuntimeCatalogue.kind, platform: process.platform, arch: process.arch,
  source: canonicalArtifacts(source.artifacts), support: canonicalArtifacts(support),
  sdkVersion: copilotRuntimeCatalogue.sdkVersion, authorityProtocol: copilotRuntimeCatalogue.authorityProtocol,
});
export function isCopilotAuthoritySource(source: ResolvedToolLaunch): boolean {
  return process.platform === "darwin" && process.arch === "arm64" && source.tool === "copilot" && source.context === "web"
    && source.runtimeProfile === undefined && source.interpreterPath === null
    && source.artifacts.some(item => item.realPath === source.executablePath && item.sha256 === copilotRuntimeCatalogue.executable);
}

async function packageScope(file: string, operation: Operation): Promise<string> {
  let directory = path.dirname(file);
  while (true) {
    const candidate = path.join(directory, "package.json");
    try { await withinOperation(lstat(candidate), operation); return await withinOperation(realpath(candidate), operation); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(directory); if (parent === directory) return fail(); directory = parent;
  }
}

/** Static runtime imports must stay inside the explicit frozen preload closure. */
export async function captureCopilotSupport(workerNode: string, operation: Operation, frozen?: { preloadPath: string; sdkManifestPath: string }): Promise<{ artifacts: ToolArtifact[]; preloadPath: string }> {
  const controller = frozen ? path.dirname(path.dirname(frozen.preloadPath)) : fileURLToPath(new URL("../commands/controller/", import.meta.url));
  if (frozen && frozen.preloadPath !== path.join(controller, copilotPreloadFiles[0])) fail();
  const files = await Promise.all(copilotPreloadFiles.map(file => withinOperation(realpath(path.join(controller, file)), operation)));
  const allowed = new Set(files), scopes = new Set<string>();
  const artifacts: ToolArtifact[] = [await fingerprintToolArtifact({ role: "interpreter", path: await withinOperation(realpath(workerNode), operation) }, operation)];
  for (const file of files) {
    const text = await readRuntimeText(file, operation);
    // Runtime adapters have a closed static module graph. Dynamic imports and
    // generic require calls cannot add an unfingerprinted dependency.
    if (/\bimport\s*\(/.test(text) || /\brequire\s*\(/.test(text)) fail();
    if (/\bcreateRequire\s*\(/.test(text)) {
      if (file !== files[0] || !text.includes('createRequire(import.meta.url)(join(dirname(process.argv[1]), "prebuilds", "darwin-arm64", "runtime.node"))')
        || [...text.matchAll(/\bcreateRequire\s*\(/g)].length !== 1) fail();
    }
    for (const match of text.matchAll(/^[ \t]*(?:import|export)[ \t]+(?:[^;\n]*?[ \t]+from[ \t]+)?["']([^"']+)["']/gm)) {
      const specifier = match[1]!;
      if (!specifier.startsWith("node:") && (!specifier.startsWith(".") || !allowed.has(await withinOperation(realpath(path.resolve(path.dirname(file), specifier)), operation)))) fail();
    }
    scopes.add(await packageScope(file, operation));
    const artifact = await fingerprintToolArtifact({ role: "support", path: file }, operation);
    if (artifact.sha256 !== textDigest(text)) fail();
    artifacts.push(artifact);
  }
  for (const scope of [...scopes].sort(compare)) {
    const text = await readRuntimeText(scope, operation);
    if (JSON.parse(text).type !== "module") fail();
    const artifact = await fingerprintToolArtifact({ role: "support", path: scope }, operation);
    if (artifact.sha256 !== textDigest(text)) fail();
    artifacts.push(artifact);
  }
  const currentSdk = await withinOperation(realpath(path.join(path.dirname(createRequire(import.meta.url).resolve("@github/copilot-sdk")), "../../package.json")), operation);
  const sdk = frozen?.sdkManifestPath ?? currentSdk;
  for (const file of new Set([currentSdk, sdk])) {
    const text = await readRuntimeText(file, operation), metadata = JSON.parse(text);
    if (metadata.name !== "@github/copilot-sdk" || metadata.version !== copilotRuntimeCatalogue.sdkVersion) fail();
    const artifact = await fingerprintToolArtifact({ role: "support", path: file }, operation);
    if (artifact.sha256 !== textDigest(text)) fail();
    if (file === sdk) artifacts.push(artifact);
  }
  return { artifacts, preloadPath: files[0]! };
}

export async function verifyCopilotToolProfile(input: ResolvedToolLaunch, operation: Operation, trustedRoot?: string): Promise<void> {
  const launch = parseResolvedToolLaunch(input), profile = launch.runtimeProfile!;
  if (!trustedRoot || !isCopilotAuthoritySource(profile.sourceLaunch) || path.dirname(profile.root) !== trustedRoot) fail();
  await verifyPrivateRuntimeDirectory(profile.root, trustedRoot!, operation);
  await verifyToolLaunch(profile.sourceLaunch, operation);
  // The Controller checks protocol compatibility, then verifies the original
  // adapter closure. Its own installation path cannot replace a frozen module.
  const sdkManifests: string[] = [];
  for (const item of launch.artifacts) if (item.role === "support" && path.basename(item.path) === "package.json") {
    const metadata = JSON.parse(await readRuntimeText(item.path, operation));
    if (metadata.name === "@github/copilot-sdk") sdkManifests.push(item.path);
  }
  if (sdkManifests.length !== 1) fail();
  const support = await captureCopilotSupport(launch.interpreterPath!, operation, { preloadPath: profile.preloadPath, sdkManifestPath: sdkManifests[0]! });
  if (support.preloadPath !== profile.preloadPath || copilotMaterializationKey(profile.sourceLaunch, support.artifacts) !== profile.materializationKey) fail();
  const expected = [...profile.sourceLaunch.artifacts, ...support.artifacts,
    await fingerprintToolArtifact({ role: "entry", path: launch.executablePath }, operation),
    await fingerprintToolArtifact({ role: "manifest", path: profile.manifestPath }, operation)];
  const normalized = (items: ToolArtifact[]) => [...items].sort((a, b) => compare(a.role, b.role) || compare(a.path, b.path));
  if (JSON.stringify(normalized(expected)) !== JSON.stringify(normalized(launch.artifacts))) fail();
  const manifestDigest = launch.artifacts.find(item => item.role === "manifest" && item.path === profile.manifestPath)!.sha256;
  const manifest = await readRuntimeManifest(profile.root, profile.materializationKey, operation, manifestDigest);
  for (const [file, digest] of Object.entries(copilotRuntimeCatalogue.files)) if (!manifest.entries.some(item => item.path === file && item.sha256 === digest)) fail();
  // Node remains an executable dependency even though the distribution is JS.
  const { access } = await import("node:fs/promises");
  if (process.platform !== "win32") await withinOperation(access(launch.command.file, 1), operation);
}

export async function syncRuntimeTree(root: string, operation: Operation): Promise<void> {
  operation.check();
  const info = await withinOperation(lstat(root), operation);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) fail();
  if (info.isDirectory()) for (const name of await withinOperation(readdir(root), operation)) await syncRuntimeTree(path.join(root, name), operation);
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | (info.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK));
  const handle = await withinOperation(open(root, flags), operation, late => late.close());
  try {
    const opened = await withinOperation(handle.stat(), operation);
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.isDirectory() !== info.isDirectory() || opened.isFile() !== info.isFile()) fail();
    await withinOperation(handle.sync(), operation);
  } finally { await withinOperation(handle.close(), operation); }
}
