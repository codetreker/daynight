import { readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ClaudeRuntimeProfile } from "./claude-live.js";

type Backend = ClaudeRuntimeProfile["backend"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const selected = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== "0" && value !== "false";
const unqualifiedSelectors = ["CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_GATEWAY"];
const backendEnvironmentKeys = new Set([...unqualifiedSelectors, "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL", "ANTHROPIC_UNIX_SOCKET", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "APPDATA", "USERPROFILE", "XDG_CONFIG_HOME", "HOME"]);
const backendEnvironment = (environment: Record<string, unknown>, platform: NodeJS.Platform): Record<string, unknown> | null => {
  if (platform !== "win32") return environment;
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toUpperCase();
    if (!backendEnvironmentKeys.has(key)) continue;
    // Node's Windows spawn selects one spelling when case variants coexist.
    // Qualification cannot depend on which duplicate spelling wins.
    if (Object.hasOwn(normalized, key)) return null;
    normalized[key] = value;
  }
  return normalized;
};
type ReadProfileText = (path: string) => string | null;
const readProfileText: ReadProfileText = path => {
  try {
    if (statSync(path).size > 1024 * 1024) throw new Error("Anthropic profile configuration exceeds the inspection limit");
    return readFileSync(path, "utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};
const officialEndpoint = (value: unknown): boolean => {
  try { const url = new URL(String(value)); return url.origin === "https://api.anthropic.com" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password; }
  catch { return false; }
};

/** Inspect profile configuration only; credential files and helpers stay private. */
export const claudeProfileEndpoint = (environment: Record<string, unknown>, platform: NodeJS.Platform, readText: ReadProfileText = readProfileText): boolean => {
  const text = (key: string): string => typeof environment[key] === "string" ? environment[key].trim() : "";
  const paths = platform === "win32" ? win32 : posix;
  const explicit = text("ANTHROPIC_PROFILE");
  // Native federation environment credentials outrank the implicit profile.
  if (!explicit && text("ANTHROPIC_FEDERATION_RULE_ID") && text("ANTHROPIC_ORGANIZATION_ID")) return true;
  const directory = text("ANTHROPIC_CONFIG_DIR") || (platform === "win32"
    ? text("APPDATA") ? paths.join(text("APPDATA"), "Anthropic") : text("USERPROFILE") ? paths.join(text("USERPROFILE"), "AppData", "Roaming", "Anthropic") : ""
    : text("XDG_CONFIG_HOME") ? paths.join(text("XDG_CONFIG_HOME"), "anthropic") : text("HOME") ? paths.join(text("HOME"), ".config", "anthropic") : "");
  if (!directory) return !explicit;
  // Relative configuration paths depend on the native process working directory.
  if (!paths.isAbsolute(directory)) return false;
  try {
    const profile = explicit || readText(paths.join(directory, "active_config"))?.trim() || "default";
    if (!/^[A-Za-z0-9_.-]+$/.test(profile) || profile === "." || profile === "..") return false;
    const source = readText(paths.join(directory, "configs", profile + ".json"));
    if (source === null) return true;
    const config = object(JSON.parse(source));
    const authentication = object(config.authentication);
    // Native profiles may be selected implicitly. Do not read credentials to
    // decide whether user_oauth is active; a possible endpoint override suffices.
    if (authentication.type !== "oidc_federation" && authentication.type !== "user_oauth") return false;
    return !config.base_url || officialEndpoint(config.base_url);
  } catch { return false; }
};
type ProfileEndpoint = (environment: Record<string, unknown>, platform: NodeJS.Platform) => boolean;
const environmentBackend = (raw: Record<string, unknown>, platform: NodeJS.Platform, profileEndpoint: ProfileEndpoint): Backend => {
  const environment = backendEnvironment(raw, platform);
  if (!environment || unqualifiedSelectors.some(key => selected(environment[key]))) return "unknown";
  // Socket transport can replace the endpoint while the CLI still reports
  // firstParty. Socket names such as "0" and "false" are paths, not flags.
  if (environment.ANTHROPIC_UNIX_SOCKET !== undefined && environment.ANTHROPIC_UNIX_SOCKET !== null && environment.ANTHROPIC_UNIX_SOCKET !== "") return "unknown";
  const bedrock = selected(environment.CLAUDE_CODE_USE_BEDROCK), vertex = selected(environment.CLAUDE_CODE_USE_VERTEX);
  if (bedrock && vertex) return "unknown";
  if (bedrock) return "bedrock";
  if (vertex) return "vertex";
  if (environment.ANTHROPIC_BASE_URL) {
    if (!officialEndpoint(environment.ANTHROPIC_BASE_URL)) return "unknown";
  }
  return environment.ANTHROPIC_BASE_URL || profileEndpoint(environment, platform) ? "anthropic" : "unknown";
};

/** A native settings override cannot widen the actual spawn's backend capability. */
export const claudeBackend = (spawnEnvironment: Record<string, unknown>, effectiveSettings: unknown, flagSettings: unknown, nativeApiProvider?: unknown, platform: NodeJS.Platform = process.platform, profileEndpoint: ProfileEndpoint = claudeProfileEndpoint): Backend => {
  if (!effectiveSettings || typeof effectiveSettings !== "object" || typeof flagSettings === "string") return "unknown";
  const settings = object(effectiveSettings), flags = object(flagSettings);
  // The SDK resolver deliberately does not execute policy helpers. Their result
  // cannot establish this profile without a native effective-settings readback.
  if (settings.policyHelper || settings.policyHelpers || flags.policyHelper || flags.policyHelpers) return "unknown";
  const actual = environmentBackend(spawnEnvironment, platform, profileEndpoint);
  // Preserve the actual JavaScript merge before applying Windows name semantics:
  // merging normalized layers would erase differently-cased duplicate keys.
  const configured = environmentBackend({ ...spawnEnvironment, ...object(settings.env), ...object(flags.env) }, platform, profileEndpoint);
  // The actual CLI reports the selected provider independently of its endpoint
  // overrides. A missing selector is not evidence that it chose first-party.
  const native = nativeApiProvider === "firstParty" ? "anthropic" : nativeApiProvider === "bedrock" || nativeApiProvider === "vertex" ? nativeApiProvider : "unknown";
  return actual === configured && actual === native ? actual : "unknown";
};
