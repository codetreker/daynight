const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.isWellFormed() && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);

/** Qualification matches both the installed SDK and the connected native runtime. */
export const copilotUsageProviderVersion = (sdkVersion: unknown, nativeVersion: unknown): string | null => {
  if (sdkVersion !== "1.0.11" || !version(nativeVersion)) return null;
  const result = `${sdkVersion}/${nativeVersion}`;
  return Buffer.byteLength(result) <= 128 ? result : null;
};

const token = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("native_integer_unrepresentable");
  return String(value);
};

/** Preserve only the fixed event plane; cumulative/context metrics are never added. */
export const mapCopilotUsageEvent = (input: unknown) => {
  const event = record(input);
  if (event.type !== "assistant.usage") return null;
  const data = record(event.data);
  if (typeof event.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.id) || !text(data.model, 128)) throw new Error("collector_failed");
  if (typeof event.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp))) throw new Error("collector_failed");
  const nativeMetrics: Record<string, string | null> = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) nativeMetrics[key] = token(data[key]);
  const outputTokens = nativeMetrics.outputTokens ?? null, reasoningTokens = nativeMetrics.reasoningTokens ?? null;
  if (outputTokens !== null && reasoningTokens !== null && BigInt(reasoningTokens) > BigInt(outputTokens)) throw new Error("collector_failed");
  if (event.agentId !== undefined) {
    if (!text(event.agentId, 256)) throw new Error("collector_failed");
    nativeMetrics.agentId = event.agentId;
    // Agent identity alone does not establish a main/subagent relationship.
    nativeMetrics.agentType = "unknown";
  }
  return {
    sourceKey: `copilot-event-v1:${event.id}`, profileId: "copilot-event-1.0.11-v1",
    revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted",
    nativeTurnId: null, nativeCallId: null, includedInSourceKey: null, model: data.model,
    metrics: { inputTokens: null, outputTokens, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens, totalTokens: null, providerTotalTokens: null },
    nativeMetrics, reasonCodes: ["input_cache_semantics_unknown", "native_recovery_gap"], observedAt: event.timestamp,
  };
};
export type CopilotUsageMeasurement = NonNullable<ReturnType<typeof mapCopilotUsageEvent>>;
