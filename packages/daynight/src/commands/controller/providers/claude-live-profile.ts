import type { ClaudeRuntimeProfile } from "./claude-live.js";

type Backend = ClaudeRuntimeProfile["backend"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const selected = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== "0" && value !== "false";
const unqualifiedSelectors = ["CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_GATEWAY"];
const backendEnvironmentKeys = new Set([...unqualifiedSelectors, "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL"]);
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
const environmentBackend = (raw: Record<string, unknown>, platform: NodeJS.Platform): Backend => {
  const environment = backendEnvironment(raw, platform);
  if (!environment || unqualifiedSelectors.some(key => selected(environment[key]))) return "unknown";
  const bedrock = selected(environment.CLAUDE_CODE_USE_BEDROCK), vertex = selected(environment.CLAUDE_CODE_USE_VERTEX);
  if (bedrock && vertex) return "unknown";
  if (bedrock) return "bedrock";
  if (vertex) return "vertex";
  if (environment.ANTHROPIC_BASE_URL) {
    try { const url = new URL(String(environment.ANTHROPIC_BASE_URL)); if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return "unknown"; }
    catch { return "unknown"; }
  }
  return "anthropic";
};

/** A native settings override cannot widen the actual spawn's backend capability. */
export const claudeBackend = (spawnEnvironment: Record<string, unknown>, effectiveSettings: unknown, flagSettings: unknown, nativeApiProvider?: unknown, platform: NodeJS.Platform = process.platform): Backend => {
  if (!effectiveSettings || typeof effectiveSettings !== "object" || typeof flagSettings === "string") return "unknown";
  const settings = object(effectiveSettings), flags = object(flagSettings);
  // The SDK resolver deliberately does not execute policy helpers. Their result
  // cannot establish this profile without a native effective-settings readback.
  if (settings.policyHelper || settings.policyHelpers || flags.policyHelper || flags.policyHelpers) return "unknown";
  const actual = environmentBackend(spawnEnvironment, platform);
  // Preserve the actual JavaScript merge before applying Windows name semantics:
  // merging normalized layers would erase differently-cased duplicate keys.
  const configured = environmentBackend({ ...spawnEnvironment, ...object(settings.env), ...object(flags.env) }, platform);
  // The actual CLI reports the selected provider independently of its endpoint
  // overrides. A missing selector is not evidence that it chose first-party.
  const native = nativeApiProvider === "firstParty" ? "anthropic" : nativeApiProvider === "bedrock" || nativeApiProvider === "vertex" ? nativeApiProvider : "unknown";
  return actual === configured && actual === native ? actual : "unknown";
};
