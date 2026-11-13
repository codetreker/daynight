import path from "node:path";
import { constants, type BigIntStats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import which from "which";
import { OperationError, type Operation } from "../api/operation.js";
import { validateToolPath, type Tool, type ToolContext, type ToolPathChoice } from "./tool-path-choice.js";
import { bundledCopilotEntry, identifyToolLauncher } from "./tool-launchers.js";
import { captureToolEnvironment } from "./tool-environment.js";
import { openRegularToolFile, withinOperation } from "./tool-io.js";

export type { Tool, ToolContext, ToolPathChoice, ToolPaths } from "./tool-path-choice.js";
export { captureToolEnvironment } from "./tool-environment.js";
export { copilotExecutable } from "./tool-launchers.js";

export type ToolArtifact = {
  role: "entry" | "shim" | "interpreter" | "runtime" | "manifest" | "support";
  path: string;
  realPath: string;
  size: string;
  sha256: string;
};
export type PlainResolvedToolLaunch = {
  schemaVersion: 1;
  tool: Tool;
  context: ToolContext;
  source: "path" | "bundled" | "explicit";
  entryPath: string;
  canonicalEntryPath: string;
  executablePath: string;
  interpreterPath: string | null;
  command: { file: string; prefixArgs: string[] };
  artifacts: ToolArtifact[];
  selectionKey: string;
};
export type CopilotAuthorityProfile = {
  kind: "copilot-read-authority-v1";
  sourceLaunch: PlainResolvedToolLaunch;
  materializationKey: string;
  root: string;
  manifestPath: string;
  preloadPath: string;
  sdkVersion: "1.0.11";
  authorityProtocol: "daynight.copilot.read.v1";
};
export type ResolvedToolLaunch = PlainResolvedToolLaunch & { runtimeProfile?: CopilotAuthorityProfile };
export type ToolSelectionCode = "not_found" | "permission_denied" | "not_executable" | "unsupported_launcher" | "unrecognized_output" |
  "incompatible_runtime" | "probe_timeout" | "cleanup_unknown" | "tool_identity_changed" | "legacy_tool_identity_missing" | "cancelled" | "invalid_path" | "io_error";
export class ToolSelectionError extends Error {
  constructor(readonly tool: Tool, readonly context: ToolContext, readonly stage: "resolve" | "verify" | "probe" | "launch", readonly code: ToolSelectionCode, options?: ErrorOptions) {
    super(`Tool ${tool} (${context}) ${stage} failed: ${code}.`, options); this.name = "ToolSelectionError";
  }
}
const codes = new Set<ToolSelectionCode>(["not_found", "permission_denied", "not_executable", "unsupported_launcher", "unrecognized_output", "incompatible_runtime", "probe_timeout", "cleanup_unknown", "tool_identity_changed", "legacy_tool_identity_missing", "cancelled", "invalid_path", "io_error"]);
const errorCode = (error: unknown): ToolSelectionCode => {
  if (error instanceof OperationError) return error.kind === "cancelled" || error.kind === "disposed" ? "cancelled" : "probe_timeout";
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  if (code && codes.has(code as ToolSelectionCode)) return code as ToolSelectionCode;
  if (code === "ENOENT" || code === "ENOTDIR") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (error instanceof TypeError) return "invalid_path";
  return "io_error";
};
const changed = (): never => { throw Object.assign(new Error("Tool file identity changed."), { code: "tool_identity_changed" }); };
const signature = (value: BigIntStats): string => [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(":");
type FileDigest = { signature: string; sha256: string; prefix: { bytes: number; sha256: string } };
// Reuse only a process-local digest for an unchanged filesystem signature.
// Every lookup still opens the file and checks its path mapping before return.
const digests = new Map<string, FileDigest>();
const digestCapacity = 128;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ordered = (artifacts: ToolArtifact[]) => [...artifacts].sort((a, b) => compare(a.role, b.role) || compare(a.path, b.path));
const commandIdentity = (command: ResolvedToolLaunch["command"]) => ({ file: command.file, prefixArgs: command.prefixArgs });
const artifactIdentity = (artifact: ToolArtifact) => ({ role: artifact.role, path: artifact.path, realPath: artifact.realPath, size: artifact.size, sha256: artifact.sha256 });
export const toolSelectionKey = (launch: Omit<ResolvedToolLaunch, "selectionKey">): string => hash({
  schemaVersion: launch.schemaVersion, tool: launch.tool, context: launch.context,
  canonicalEntryPath: launch.canonicalEntryPath, executablePath: launch.executablePath, interpreterPath: launch.interpreterPath,
  command: commandIdentity(launch.command), artifacts: ordered(launch.artifacts).map(artifactIdentity),
  ...(launch.runtimeProfile === undefined ? {} : { runtimeProfile: {
    kind: launch.runtimeProfile.kind, sourceSelectionKey: launch.runtimeProfile.sourceLaunch.selectionKey,
    materializationKey: launch.runtimeProfile.materializationKey, root: launch.runtimeProfile.root,
    manifestPath: launch.runtimeProfile.manifestPath, preloadPath: launch.runtimeProfile.preloadPath,
    sdkVersion: launch.runtimeProfile.sdkVersion, authorityProtocol: launch.runtimeProfile.authorityProtocol,
  } }),
});

/** Stream file content under the operation deadline and reject replacement during observation. */
export const fingerprintToolArtifact = async (input: Pick<ToolArtifact, "role" | "path"> & { parsedPrefix?: { bytes: number; sha256: string } }, operation: Operation): Promise<ToolArtifact> => {
  operation.check();
  const realPath = await withinOperation(realpath(input.path), operation);
  const handle = await openRegularToolFile(realPath, operation);
  try {
    const before = await withinOperation(handle.stat({ bigint: true }), operation);
    if (!before.isFile()) throw Object.assign(new Error("Tool artifact must be a regular file."), { code: "not_executable" });
    let result = digests.get(realPath);
    if (result?.signature !== signature(before)) result = undefined;
    if (result === undefined) {
      const digest = createHash("sha256"), prefix = createHash("sha256");
      let remaining = 4096;
      const stream = handle.createReadStream({ autoClose: false, signal: operation.signal, highWaterMark: 64 * 1024 });
      try { for await (const chunk of stream) {
        operation.check(); digest.update(chunk);
        if (remaining > 0) { const bytes = Buffer.from(chunk).subarray(0, remaining); prefix.update(bytes); remaining -= bytes.length; }
      } }
      catch (error) { stream.destroy(); throw error; }
      result = { signature: signature(before), sha256: digest.digest("hex"), prefix: { bytes: 4096 - remaining, sha256: prefix.digest("hex") } };
    }
    const after = await withinOperation(handle.stat({ bigint: true }), operation);
    const current = await withinOperation(stat(input.path, { bigint: true }), operation);
    if (signature(before) !== signature(after) || signature(before) !== signature(current) || await withinOperation(realpath(input.path), operation) !== realPath) changed();
    if (input.parsedPrefix && (result.prefix.bytes !== input.parsedPrefix.bytes || result.prefix.sha256 !== input.parsedPrefix.sha256)) changed();
    digests.delete(realPath); digests.set(realPath, result);
    if (digests.size > digestCapacity) digests.delete(digests.keys().next().value!);
    return { role: input.role, path: input.path, realPath, size: before.size.toString(), sha256: result.sha256 };
  } finally { await withinOperation(handle.close(), operation); }
};

const executable = async (file: string, operation: Operation): Promise<void> => {
  const status = await withinOperation(stat(file), operation);
  if (!status.isFile()) throw Object.assign(new Error("Tool command is not a regular file."), { code: "not_executable" });
  if (process.platform !== "win32") await withinOperation(access(file, constants.X_OK), operation);
};

/** Resolve only the supplied choice; errors never select a different installation. No process is started. */
export const resolveToolLaunch = async (input: {
  tool: Tool; context: ToolContext; choice: ToolPathChoice;
  environment: NodeJS.ProcessEnv; cwd: string; workerNode?: string;
}, operation: Operation): Promise<ResolvedToolLaunch> => {
  const { tool, context } = input;
  try {
    operation.check();
    if (!["codex", "copilot", "herdr"].includes(tool) || !["web", "herdr"].includes(context) || tool === "herdr" && context !== "herdr") throw new TypeError("Unsupported tool context.");
    validateToolPath(input.cwd, "tool cwd");
    const environment = captureToolEnvironment(input.environment);
    let entryPath: string, source: ResolvedToolLaunch["source"];
    if (input.choice.kind === "path") { entryPath = validateToolPath(input.choice.path); source = "explicit"; }
    else if (input.choice.kind !== "auto") throw new TypeError("Invalid tool choice.");
    else if (tool === "copilot" && context === "web") { entryPath = bundledCopilotEntry(); source = "bundled"; }
    else {
      const directories = [...(process.platform === "win32" ? [input.cwd] : []), ...(environment.PATH ?? "").split(path.delimiter)];
      let found: string | null = null;
      for (const directory of directories) {
        // Absolute candidates keep which from consulting process.cwd() or the
        // current process PATH instead of this captured search environment.
        const unquoted = process.platform === "win32" && /^".*"$/.test(directory) ? directory.slice(1, -1) : directory;
        found = await withinOperation(which(path.resolve(input.cwd, unquoted, tool), { nothrow: true, pathExt: environment.PATHEXT ?? "" }), operation);
        if (found !== null) break;
      }
      if (found === null) throw Object.assign(new Error("Selected tool was not found on the captured PATH."), { code: "not_found" });
      entryPath = found; source = "path";
    }
    validateToolPath(entryPath);
    const canonicalEntryPath = await withinOperation(realpath(entryPath), operation);
    const launcher = await identifyToolLauncher(entryPath, tool, operation);
    const interpreterEntry = launcher.interpreterRequired ? validateToolPath(input.workerNode ?? process.execPath, "Worker Node") : null;
    let interpreterPath: string | null = null;
    if (interpreterEntry !== null) {
      try { interpreterPath = await withinOperation(realpath(interpreterEntry), operation); }
      catch (error) {
        if (errorCode(error) === "not_found") throw new ToolSelectionError(tool, context, "resolve", "incompatible_runtime", { cause: error });
        throw error;
      }
    }
    const command = interpreterPath === null ? { file: launcher.executablePath, prefixArgs: [] } : { file: interpreterPath, prefixArgs: [launcher.executablePath] };
    await executable(command.file, operation);
    const sources = [...launcher.artifacts, ...(interpreterEntry === null ? [] : [{ role: "interpreter" as const, path: interpreterEntry }])];
    const artifacts: ToolArtifact[] = [];
    for (const candidate of sources) {
      if (candidate.role === "runtime") await executable(candidate.path, operation);
      const artifact = await fingerprintToolArtifact(candidate, operation);
      if ("parsedSha256" in candidate && candidate.parsedSha256 !== undefined && artifact.sha256 !== candidate.parsedSha256) changed();
      if (!artifacts.some(item => item.role === artifact.role && item.path === artifact.path)) artifacts.push(artifact);
    }
    if (await withinOperation(realpath(entryPath), operation) !== canonicalEntryPath) changed();
    const executableRole = launcher.interpreterRequired ? "entry" : launcher.artifacts.some(item => item.role === "runtime") ? "runtime" : "entry";
    if (!artifacts.some(item => item.role === executableRole && item.realPath === launcher.executablePath)) changed();
    if (interpreterPath !== null && !artifacts.some(item => item.role === "interpreter" && item.realPath === interpreterPath)) changed();
    const value: Omit<ResolvedToolLaunch, "selectionKey"> = { schemaVersion: 1, tool, context, source, entryPath, canonicalEntryPath, executablePath: launcher.executablePath, interpreterPath, command, artifacts: ordered(artifacts) };
    const launch = { ...value, selectionKey: toolSelectionKey(value) };
    await verifyToolLaunch(launch, operation);
    return launch;
  } catch (error) { throw new ToolSelectionError(tool, context, "resolve", errorCode(operation.signal.aborted ? operation.signal.reason : error), { cause: error }); }
};

/** Recheck the frozen files and mappings without reading current configuration or searching PATH. */
export const verifyToolLaunch = async (launch: ResolvedToolLaunch, operation: Operation, options: { trustedRuntimeRoot?: string } = {}): Promise<void> => {
  try {
    operation.check();
    if (launch.schemaVersion !== 1 || toolSelectionKey(launch) !== launch.selectionKey) changed();
    if (launch.runtimeProfile !== undefined) {
      const { verifyCopilotToolProfile } = await import("./tool-runtime-profile.js");
      await verifyCopilotToolProfile(launch, operation, options.trustedRuntimeRoot);
      return;
    }
    if (await withinOperation(realpath(launch.entryPath), operation) !== launch.canonicalEntryPath) changed();
    for (const artifact of launch.artifacts) {
      const current = await fingerprintToolArtifact({ role: artifact.role, path: artifact.path }, operation);
      if (current.realPath !== artifact.realPath || current.size !== artifact.size || current.sha256 !== artifact.sha256) changed();
      if (artifact.role === "runtime") await executable(artifact.path, operation);
    }
    await executable(launch.command.file, operation);
  } catch (error) {
    const code = errorCode(operation.signal.aborted ? operation.signal.reason : error);
    throw new ToolSelectionError(launch.tool, launch.context, "verify", code === "probe_timeout" || code === "cancelled" ? code : "tool_identity_changed", { cause: error });
  }
};

/** Build argv as data. Callers must verify the frozen launch before spawning it. */
export const toolCommand = (launch: ResolvedToolLaunch, args: readonly string[]): { file: string; args: string[] } => ({ file: launch.command.file, args: [...launch.command.prefixArgs, ...args] });

/** Share probe cleanup across lexical aliases while preserving the caller's cwd/native environment isolation. */
export const probeResourceKey = (launch: ResolvedToolLaunch, scope: { cwd: string; environment: NodeJS.ProcessEnv }): string => {
  const artifacts = launch.artifacts.map(({ role, realPath, size, sha256 }) => ({ role, realPath, size, sha256 }));
  artifacts.sort((a, b) => compare(a.role, b.role) || compare(a.realPath, b.realPath));
  const environment = captureToolEnvironment(scope.environment);
  return hash({ tool: launch.tool, command: commandIdentity(launch.command), artifacts, cwd: scope.cwd,
    ...(launch.runtimeProfile === undefined ? {} : { runtimeProfile: launch.runtimeProfile.kind }),
    // PATH selects an entry only at resolution. Reintroducing it here would let
    // auto and an absolute alias evade the same unresolved cleanup owner.
    // Capture already normalizes Windows search keys; POSIX names stay case-sensitive.
    environment: Object.fromEntries(Object.keys(environment).filter(key => key !== "PATH" && key !== "PATHEXT").sort().map(key => [key, environment[key]])),
  });
};
