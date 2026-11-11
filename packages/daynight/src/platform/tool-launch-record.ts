import path from "node:path";
import { pathToFileURL } from "node:url";
import { toolSelectionKey, type ResolvedToolLaunch, type Tool, type ToolContext } from "./tool-executables.js";
import { validateToolPath } from "./tool-path-choice.js";

const invalid = (): never => { throw new TypeError("Frozen tool launch is invalid."); };
const object = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== [...fields].sort().join()) return invalid();
  return record;
};
const hash = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid();

/** Parse a complete frozen recipe without resolving PATH, reading files or changing its identity. */
export const parseResolvedToolLaunch = (value: unknown, expected: { tool?: Tool; context?: ToolContext } = {}): ResolvedToolLaunch => {
  const profilePresent = !!value && typeof value === "object" && "runtimeProfile" in value;
  const row = object(value, [...(profilePresent ? ["runtimeProfile"] : []), "schemaVersion", "tool", "context", "source", "entryPath", "canonicalEntryPath", "executablePath", "interpreterPath", "command", "artifacts", "selectionKey"]);
  if (row.schemaVersion !== 1 || !["codex", "copilot", "herdr"].includes(String(row.tool)) || !["web", "herdr"].includes(String(row.context))
    || row.tool === "herdr" && row.context !== "herdr" || !["path", "bundled", "explicit"].includes(String(row.source))
    || row.source === "bundled" && (row.tool !== "copilot" || row.context !== "web")
    || expected.tool !== undefined && expected.tool !== row.tool || expected.context !== undefined && expected.context !== row.context) invalid();
  for (const key of ["entryPath", "canonicalEntryPath", "executablePath"]) validateToolPath(row[key]);
  if (row.interpreterPath !== null) validateToolPath(row.interpreterPath);
  const command = object(row.command, ["file", "prefixArgs"]);
  validateToolPath(command.file);
  if (!Array.isArray(command.prefixArgs) || command.prefixArgs.length > 8 || command.prefixArgs.some(arg => typeof arg !== "string" || /\p{Cc}/u.test(arg) || !arg.isWellFormed() || Buffer.byteLength(arg) > 8192)) invalid();
  if (row.interpreterPath === null ? command.file !== row.executablePath || (command.prefixArgs as unknown[]).length !== 0
    : command.file !== row.interpreterPath || (command.prefixArgs as unknown[]).at(-1) !== row.executablePath) invalid();
  if (!Array.isArray(row.artifacts) || row.artifacts.length === 0 || row.artifacts.length > 128) invalid();
  const identities = new Set<string>();
  for (const item of row.artifacts as unknown[]) {
    const artifact = object(item, ["role", "path", "realPath", "size", "sha256"]);
    if (!["entry", "shim", "interpreter", "runtime", "manifest", ...(profilePresent ? ["support"] : [])].includes(String(artifact.role))) invalid();
    validateToolPath(artifact.path); validateToolPath(artifact.realPath); hash(artifact.sha256);
    if (typeof artifact.size !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(artifact.size) || BigInt(artifact.size) > 9_223_372_036_854_775_807n) invalid();
    const key = `${artifact.role}\0${artifact.path}`;
    if (identities.has(key)) invalid(); identities.add(key);
  }
  if (!profilePresent && row.interpreterPath !== null) {
    const args = command.prefixArgs as string[];
    if (JSON.stringify(args) !== JSON.stringify([row.executablePath])
      && (row.tool !== "codex" || JSON.stringify(args) !== JSON.stringify(["--no-global-search-paths", "--no-preserve-symlinks", "--no-preserve-symlinks-main", row.executablePath]))) invalid();
  }
  if (profilePresent) {
    if (row.tool !== "copilot" || row.context !== "web" || row.interpreterPath === null) invalid();
    const profile = object(row.runtimeProfile, ["kind", "sourceLaunch", "materializationKey", "root", "manifestPath", "preloadPath", "sdkVersion", "authorityProtocol"]);
    if (profile.kind !== "copilot-read-authority-v1" || profile.sdkVersion !== "1.0.11" || profile.authorityProtocol !== "daynight.copilot.read.v1"
      || !profile.sourceLaunch || typeof profile.sourceLaunch !== "object" || "runtimeProfile" in profile.sourceLaunch) invalid();
    const source = parseResolvedToolLaunch(profile.sourceLaunch, { tool: "copilot", context: "web" });
    if (source.interpreterPath !== null || source.entryPath !== row.entryPath || source.canonicalEntryPath !== row.canonicalEntryPath || source.source !== row.source) invalid();
    hash(profile.materializationKey);
    for (const key of ["root", "manifestPath", "preloadPath"]) validateToolPath(profile[key]);
    const root = profile.root as string;
    if (path.basename(root) !== profile.materializationKey || profile.manifestPath !== path.join(root, "manifest.json")
      || row.executablePath !== path.join(root, "distribution", "index.js")
      || JSON.stringify(command.prefixArgs) !== JSON.stringify(["--import", pathToFileURL(profile.preloadPath as string).href, row.executablePath])) invalid();
    const artifacts = row.artifacts as ResolvedToolLaunch["artifacts"];
    if (!source.artifacts.every(item => artifacts.some(other => other.role === item.role && other.path === item.path && other.realPath === item.realPath && other.size === item.size && other.sha256 === item.sha256))
      || !artifacts.some(item => item.role === "support" && item.path === profile.preloadPath && item.realPath === profile.preloadPath)
      || !artifacts.some(item => item.role === "manifest" && item.path === profile.manifestPath && item.realPath === profile.manifestPath)) invalid();
  }
  const launch = structuredClone(row) as unknown as ResolvedToolLaunch;
  if (!launch.artifacts.some(item => item.realPath === launch.executablePath && (item.role === "entry" || item.role === "runtime"))
    || launch.interpreterPath !== null && !launch.artifacts.some(item => item.role === "interpreter" && item.realPath === launch.interpreterPath)
    || toolSelectionKey(launch) !== hash(launch.selectionKey)) invalid();
  return launch;
};
