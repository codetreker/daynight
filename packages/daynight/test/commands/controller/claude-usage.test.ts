import { expect, test } from "vitest";
import { claudeUsageProfileSupported, claudeUsageProviderVersion, mapClaudeUsageEvent } from "../../../src/commands/controller/providers/claude-usage.js";

const profile = { sdkVersion: "0.3.247", cliVersion: "2.1.247", executable: "/native/claude", backend: "anthropic" as const };
const event = () => ({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_native", model: "claude-test", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 0 } } });

test("Claude input facts include disjoint cache while placeholder output stays unknown", () => {
  const mapped = mapClaudeUsageEvent(event());
  expect(mapped).toMatchObject({ sourceKey: "claude-message-input-v1:msg_native", profileId: "claude-message-input-0.3.247-v1", sourceRevision: "1", finality: "final", metrics: { inputTokens: "60", cacheReadTokens: "20", cacheWriteTokens: "30", outputTokens: null, reasoningTokens: null, totalTokens: null, providerTotalTokens: null }, nativeMetrics: { input_tokens: "10", cache_read_input_tokens: "20", cache_creation_input_tokens: "30" }, reasonCodes: ["subagent_scope_unknown"] });
  expect(mapClaudeUsageEvent({ ...event(), uuid: "different-wrapper" })?.sourceKey).toBe(mapped?.sourceKey);
});

test("Claude input sums remain exact beyond the JavaScript safe integer range", () => {
  const value = event(); value.message.usage.input_tokens = Number.MAX_SAFE_INTEGER;
  expect(mapClaudeUsageEvent(value)?.metrics.inputTokens).toBe("9007199254741041");
});

test("missing cache differs from an observed zero", () => {
  const value = event();
  expect(mapClaudeUsageEvent({ ...value, message: { ...value.message, usage: { input_tokens: 10, cache_read_input_tokens: 0 } } })?.metrics).toMatchObject({ inputTokens: null, cacheReadTokens: "0", cacheWriteTokens: null });
});

test.each([-1, 0.5, NaN, Infinity, "3"])("rejects malformed native input %s", input_tokens => {
  const value = event();
  expect(() => mapClaudeUsageEvent({ ...value, message: { ...value.message, usage: { ...value.message.usage, input_tokens } } })).toThrow("native_integer_unrepresentable");
});

test.each(["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const)("unsafe %s stays unknown while other input facts survive", key => {
  const value = event();
  value.message.usage[key] = Number.MAX_SAFE_INTEGER + 1;
  const mapped = mapClaudeUsageEvent(value)!;
  expect(mapped.metrics.inputTokens).toBeNull();
  expect(mapped.nativeMetrics[key]).toBeNull();
  expect(mapped.reasonCodes).toEqual(["native_integer_unrepresentable", "subagent_scope_unknown"]);
  for (const other of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    if (other !== key) expect(mapped.nativeMetrics[other]).toBe(String(value.message.usage[other]));
  }
  expect(mapped.metrics.cacheReadTokens).toBe(key === "cache_read_input_tokens" ? null : "20");
  expect(mapped.metrics.cacheWriteTokens).toBe(key === "cache_creation_input_tokens" ? null : "30");
});

test("stream frames, cumulative results, subagents and synthetic errors are not input facts", () => {
  for (const value of [{ ...event(), type: "stream_event" }, { ...event(), type: "result" }, { ...event(), parent_tool_use_id: "tool-child" }, { ...event(), parent_tool_use_id: undefined }, { ...event(), isApiErrorMessage: true }]) expect(mapClaudeUsageEvent(value)).toBeNull();
  expect(() => mapClaudeUsageEvent({ ...event(), message: { ...event().message, id: undefined }, uuid: "wrapper" })).toThrow("collector_failed");
});

test("qualification records actual CLI and backend without widening the fixed SDK profile", () => {
  expect(claudeUsageProviderVersion(profile)).toBe("0.3.247/2.1.247/anthropic");
  expect(claudeUsageProfileSupported(profile)).toBe(true);
  for (const value of [null, { ...profile, sdkVersion: "0.3.248" }, { ...profile, cliVersion: "unknown" }, { ...profile, backend: "unknown" as const }, { ...profile, backend: "bedrock" as const }]) expect(claudeUsageProfileSupported(value)).toBe(false);
  expect(claudeUsageProviderVersion({ ...profile, backend: "unknown" })).toBe("0.3.247/2.1.247/unknown");
});
