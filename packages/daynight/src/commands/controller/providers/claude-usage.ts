import type { ClaudeRuntimeProfile } from "./claude-live.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.isWellFormed() && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);

/** Backend identity is part of qualification, including for the same SDK and CLI. */
export const claudeUsageProviderVersion = (profile: ClaudeRuntimeProfile | null | undefined): string => {
  if (!profile || !version(profile.sdkVersion) || !version(profile.cliVersion) || !["anthropic", "bedrock", "vertex", "unknown"].includes(profile.backend)) return "unverified";
  const result = `${profile.sdkVersion}/${profile.cliVersion}/${profile.backend}`;
  return Buffer.byteLength(result) <= 128 ? result : "unverified";
};
export const claudeUsageProfileSupported = (profile: ClaudeRuntimeProfile | null | undefined): boolean => profile?.sdkVersion === "0.3.247" && profile.backend === "anthropic" && claudeUsageProviderVersion(profile) !== "unverified";

const token = (value: unknown, reasons: Set<string>): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new Error("native_integer_unrepresentable");
  if (!Number.isSafeInteger(value)) { reasons.add("native_integer_unrepresentable"); return null; }
  return String(value);
};

/** Completed root messages expose input facts; wrapper output is a placeholder. */
export const mapClaudeUsageEvent = (input: unknown) => {
  const event = object(input);
  if (event.type !== "assistant" || event.parent_tool_use_id !== null) return null;
  if (event.aborted === true || event.isApiErrorMessage === true || event.error !== undefined && event.error !== null) return null;
  const message = object(event.message), usage = object(message.usage);
  if (!text(message.stop_reason, 128)) return null;
  if (!text(message.id, 232) || !text(message.model, 128)) throw new Error("collector_failed");
  const reasons = new Set(["subagent_scope_unknown"]);
  const nativeMetrics = {
    input_tokens: token(usage.input_tokens, reasons),
    cache_read_input_tokens: token(usage.cache_read_input_tokens, reasons),
    cache_creation_input_tokens: token(usage.cache_creation_input_tokens, reasons),
  };
  const values = Object.values(nativeMetrics);
  const inputTokens = values.every((value): value is string => value !== null) ? values.reduce((sum, value) => sum + BigInt(value), 0n).toString() : null;
  return {
    sourceKey: `claude-message-input-v1:${message.id}`, profileId: "claude-message-input-0.3.247-v1",
    revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted",
    nativeTurnId: null, nativeCallId: null, includedInSourceKey: null, model: message.model,
    metrics: { inputTokens, outputTokens: null, cacheReadTokens: nativeMetrics.cache_read_input_tokens, cacheWriteTokens: nativeMetrics.cache_creation_input_tokens, reasoningTokens: null, totalTokens: null, providerTotalTokens: null },
    nativeMetrics, reasonCodes: [...reasons].sort(), observedAt: new Date().toISOString(),
  };
};

/** Raw root streams supply final input corrections after completed block wrappers. */
export const createClaudeUsageCollector = (observe: (event: unknown) => void, gap: () => void) => {
  let pending: { id: string; model: string; usage: Record<string, unknown>; stopReason: string | null } | null = null;
  let suppressed = false;
  const discard = () => { if (pending) { pending = null; gap(); } };
  const suppress = () => { pending = null; suppressed = true; gap(); };
  return {
    discard,
    observe(input: unknown) {
      const wrapper = object(input);
      // The CLI can change model within the same native message and omit its
      // internal fallback block from the public stream. Its initial model then
      // cannot attribute the final usage. Only a new start restores provenance.
      if (wrapper.type === "system" && wrapper.subtype === "model_refusal_fallback") {
        if (wrapper.scope !== "local" && (wrapper.parent_tool_use_id === undefined || wrapper.parent_tool_use_id === null)) suppress();
        return;
      }
      if (wrapper.parent_tool_use_id !== null) return;
      if (wrapper.type === "assistant") {
        if (suppressed) return;
        if (wrapper.aborted === true || wrapper.error !== undefined && wrapper.error !== null || wrapper.isApiErrorMessage === true) { discard(); return; }
        // A non-streamed complete message already carries its own terminal proof.
        // Block wrappers have null stop_reason and cannot commit immutable usage.
        if (!pending && text(object(wrapper.message).stop_reason, 128)) observe(wrapper);
        return;
      }
      if (wrapper.type !== "stream_event") return;
      const event = object(wrapper.event);
      if (event.type === "message_start") {
        discard();
        const message = object(event.message);
        if (!text(message.id, 232) || !text(message.model, 128)) { gap(); return; }
        suppressed = false;
        const usage = object(message.usage);
        pending = { id: message.id, model: message.model, usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens }, stopReason: null };
      } else if (event.type === "message_delta") {
        const usage = object(event.usage), delta = object(event.delta);
        if (Array.isArray(usage.iterations) && usage.iterations.some(item => object(item).type === "fallback_message")) { suppress(); return; }
        if (suppressed) return;
        if (!pending) { gap(); return; }
        for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) if (usage[key] !== undefined && usage[key] !== null) pending.usage[key] = usage[key];
        pending.stopReason = text(delta.stop_reason, 128) ? delta.stop_reason : null;
      } else if (event.type === "message_stop") {
        if (suppressed) return;
        const completed = pending; pending = null;
        if (!completed?.stopReason) { gap(); return; }
        observe({ type: "assistant", parent_tool_use_id: null, message: { id: completed.id, model: completed.model, usage: completed.usage, stop_reason: completed.stopReason } });
      }
    },
  };
};
