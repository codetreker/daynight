import type { ClaudeRuntimeProfile } from "./claude-live.js";

type Backend = ClaudeRuntimeProfile["backend"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const selected = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== "0" && value !== "false";
const environmentBackend = (environment: Record<string, unknown>): Backend => {
  if (selected(environment.CLAUDE_CODE_USE_FOUNDRY)) return "unknown";
  if (selected(environment.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (selected(environment.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (environment.ANTHROPIC_BASE_URL) {
    try { const url = new URL(String(environment.ANTHROPIC_BASE_URL)); if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return "unknown"; }
    catch { return "unknown"; }
  }
  return "anthropic";
};

/** A native settings override cannot widen the actual spawn's backend capability. */
export const claudeBackend = (spawnEnvironment: Record<string, unknown>, effectiveSettings: unknown, flagSettings: unknown): Backend => {
  if (!effectiveSettings || typeof effectiveSettings !== "object" || typeof flagSettings === "string") return "unknown";
  const settings = object(effectiveSettings), flags = object(flagSettings);
  // The SDK resolver deliberately does not execute policy helpers. Their result
  // cannot establish this profile without a native effective-settings readback.
  if (settings.policyHelper || settings.policyHelpers || flags.policyHelper || flags.policyHelpers) return "unknown";
  const actual = environmentBackend(spawnEnvironment);
  const configured = environmentBackend({ ...spawnEnvironment, ...object(settings.env), ...object(flags.env) });
  return actual === configured ? actual : "unknown";
};
