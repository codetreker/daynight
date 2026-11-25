import { valid } from "semver";
import { createHash } from "node:crypto";

/** The connected App Server supplies its version; PATH probes cannot replace it. */
export const codexUsageProviderVersion = (initialized: unknown): string | null => {
  if (!initialized || typeof initialized !== "object") return null;
  const userAgent = (initialized as Record<string, unknown>).userAgent;
  if (typeof userAgent !== "string") return null;
  const version = /^daynight\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?) \(/.exec(userAgent)?.[1];
  return version && version.length <= 128 && valid(version) !== null ? version : null;
};

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.isWellFormed() && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const token = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("native_integer_unrepresentable");
  return String(value);
};
/** Long opaque response IDs are hashed without truncation in the thread namespace. */
export const codexResponseIdentity = (threadId: string, responseId: string): string => createHash("sha256").update(JSON.stringify([threadId, responseId])).digest("hex");

/** This plane is one observed response, never a cumulative/context snapshot. */
export const mapCodexUsageEvent = (input: unknown) => {
  const event = object(input);
  if (event.method !== "rawResponse/completed") return null;
  const p = object(event.params);
  if (!text(p.threadId, 256) || !text(p.turnId, 256) || !text(p.responseId, 64 * 1024)) throw new Error("collector_failed");
  const raw = object(p.usage), nativeMetrics: Record<string, string | null> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"]) nativeMetrics[key] = token(raw[key]);
  const inputTokens = nativeMetrics.inputTokens ?? null, outputTokens = nativeMetrics.outputTokens ?? null, totalTokens = nativeMetrics.totalTokens ?? null;
  const positive = (key: string) => nativeMetrics[key] !== null && nativeMetrics[key] !== undefined && BigInt(nativeMetrics[key]!) > 0n ? nativeMetrics[key]! : null;
  const cacheReadTokens = positive("cachedInputTokens"), reasoningTokens = positive("reasoningOutputTokens");
  if (inputTokens !== null && outputTokens !== null && totalTokens !== null && BigInt(inputTokens) + BigInt(outputTokens) !== BigInt(totalTokens)
    || inputTokens !== null && cacheReadTokens !== null && BigInt(cacheReadTokens) > BigInt(inputTokens)
    || outputTokens !== null && reasoningTokens !== null && BigInt(reasoningTokens) > BigInt(outputTokens)) throw new Error("collector_failed");
  const identity = codexResponseIdentity(p.threadId, p.responseId);
  return {
    sourceKey: `codex-response-v1:${identity}`, profileId: "codex-response-0.169.0-v1",
    revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted",
    nativeTurnId: p.turnId, nativeCallId: identity, includedInSourceKey: null, model: null,
    metrics: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: null, reasoningTokens, totalTokens, providerTotalTokens: totalTokens },
    nativeMetrics, reasonCodes: ["model_unknown", "native_recovery_gap", "subagent_scope_unknown"], observedAt: new Date().toISOString(),
  };
};
