import { expect, test } from "vitest";
import { claudeUsageProfileSupported, claudeUsageProviderVersion, createClaudeUsageCollector, mapClaudeUsageEvent } from "../../../src/commands/controller/providers/claude-usage.js";

const profile = { sdkVersion: "0.3.247", cliVersion: "2.1.247", executable: "/native/claude", backend: "anthropic" as const };
const event = () => ({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_native", stop_reason: "end_turn", model: "claude-test", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 0 } } });

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

test("block wrappers remain provisional until delta corrections and root message stop", () => {
  const facts: unknown[] = [], gaps: string[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => gaps.push("gap"));
  const stream = (event: unknown, parent_tool_use_id: string | null = null) => collector.observe({ type: "stream_event", parent_tool_use_id, event });
  const complete = () => {
    stream({ type: "message_start", message: event().message });
    collector.observe({ ...event(), message: { ...event().message, stop_reason: null } });
    stream({ type: "content_block_stop", index: 0 });
    expect(facts).toHaveLength(0);
    stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 60 } });
    stream({ type: "message_stop" }, "subagent");
    expect(facts).toHaveLength(0);
    stream({ type: "message_stop" });
  };
  complete();
  const first = mapClaudeUsageEvent(facts[0]);
  expect(first?.metrics).toMatchObject({ inputTokens: "150", cacheReadTokens: "50", cacheWriteTokens: "60", outputTokens: null });
  facts.length = 0; complete();
  const replay = mapClaudeUsageEvent(facts[0]);
  expect(replay?.sourceKey).toBe(first?.sourceKey); expect(replay?.nativeMetrics).toEqual(first?.nativeMetrics);
  expect(gaps).toEqual([]);
});

test("incomplete streams never manufacture immutable input facts", () => {
  const facts: unknown[] = [], gaps: string[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => gaps.push("gap"));
  const start = () => collector.observe({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: event().message } });
  start(); start(); expect(gaps).toHaveLength(1);
  collector.discard(); expect(gaps).toHaveLength(2);
  start(); collector.observe({ ...event(), aborted: true }); expect(gaps).toHaveLength(3);
  start(); collector.observe({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
  expect(gaps).toHaveLength(4); expect(facts).toEqual([]);
  expect(mapClaudeUsageEvent({ ...event(), message: { ...event().message, stop_reason: null } })).toBeNull();
  expect(mapClaudeUsageEvent({ ...event(), aborted: true })).toBeNull();
});

test("output-only terminal delta preserves observed inputs without inventing missing cache", () => {
  const facts: unknown[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => { throw new Error("Unexpected stream gap"); });
  const stream = (event: unknown) => collector.observe({ type: "stream_event", parent_tool_use_id: null, event });
  stream({ type: "message_start", message: { id: "msg_partial_cache", model: "claude-test", usage: { input_tokens: 10, cache_read_input_tokens: 0 } } });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
  stream({ type: "message_stop" });
  expect(mapClaudeUsageEvent(facts[0])?.metrics).toMatchObject({ inputTokens: null, cacheReadTokens: "0", cacheWriteTokens: null, outputTokens: null });
});

test.each(["system", "iterations"])("%s fallback suppresses the ambiguous message through stop and complete wrappers", signal => {
  const facts: unknown[] = [], gaps: string[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => gaps.push("gap"));
  const stream = (event: unknown) => collector.observe({ type: "stream_event", parent_tool_use_id: null, event });
  stream({ type: "message_start", message: event().message });
  if (signal === "system") collector.observe({ type: "system", subtype: "model_refusal_fallback", original_model: "claude-test", fallback_model: "different-model" });
  else stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { iterations: [{ type: "fallback_message", model: "different-model" }], input_tokens: 90 } });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 100 } });
  stream({ type: "message_stop" });
  collector.observe(event()); collector.discard(); collector.observe(event());
  expect(facts).toEqual([]); expect(gaps).toHaveLength(1);
  stream({ type: "message_start", message: { id: "missing-model" } });
  collector.observe(event()); expect(facts).toEqual([]); expect(gaps).toHaveLength(2);
  stream({ type: "message_start", message: { ...event().message, id: "msg_new" } });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } });
  stream({ type: "message_stop" });
  expect(facts).toHaveLength(1); expect(mapClaudeUsageEvent(facts[0])?.sourceKey).toBe("claude-message-input-v1:msg_new");
});

test("a local fallback notice cannot discard an unrelated root stream", () => {
  const facts: unknown[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => { throw new Error("Unexpected root gap"); });
  const stream = (event: unknown) => collector.observe({ type: "stream_event", parent_tool_use_id: null, event });
  stream({ type: "message_start", message: event().message });
  collector.observe({ type: "system", subtype: "model_refusal_fallback", scope: "local" });
  collector.observe({ type: "system", subtype: "model_refusal_fallback", parent_tool_use_id: "child" });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }); stream({ type: "message_stop" });
  expect(facts).toHaveLength(1);
});

test("synthetic refusal closure cannot commit before the delayed fallback notice", () => {
  const facts: unknown[] = [], gaps: string[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => gaps.push("gap"));
  const stream = (event: unknown) => collector.observe({ type: "stream_event", parent_tool_use_id: null, event });
  stream({ type: "message_start", message: { ...event().message, usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text" } });
  stream({ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { input_tokens: 0 } });
  stream({ type: "message_stop" });
  expect(facts).toEqual([]);
  collector.observe({ type: "system", subtype: "model_refusal_fallback" });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 60 } });
  stream({ type: "message_stop" });
  collector.observe(event());
  expect(facts).toEqual([]); expect(gaps.length).toBeGreaterThan(0);
  const refusal = { ...event(), message: { ...event().message, stop_reason: "refusal" } };
  expect(mapClaudeUsageEvent(refusal)).toBeNull();
  const isolated = createClaudeUsageCollector(value => facts.push(value), () => {});
  isolated.observe(refusal); isolated.observe(event());
  expect(facts).toEqual([]);
  stream({ type: "message_start", message: { ...event().message, id: "msg_after_refusal" } });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
  stream({ type: "message_stop" });
  expect(facts).toHaveLength(1);
  expect(mapClaudeUsageEvent(facts[0])?.sourceKey).toBe("claude-message-input-v1:msg_after_refusal");
});

test("complete new-ID retry retires a failed stream without accepting provisional wrappers", () => {
  const facts: unknown[] = [], gaps: string[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => gaps.push("gap"));
  collector.observe({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...event().message, id: "msg_failed_stream" } } });
  collector.observe({ ...event(), message: { ...event().message, id: "msg_failed_stream" } });
  collector.observe({ ...event(), message: { ...event().message, id: "msg_provisional_retry", stop_reason: null } });
  collector.observe({ ...event(), parent_tool_use_id: "child" });
  collector.observe({ ...event(), message: { ...event().message, id: undefined } });
  expect(facts).toEqual([]); expect(gaps).toEqual([]);
  collector.observe(event());
  collector.discard(); // The provider discards any unfinished stream on result.
  expect(gaps).toEqual(["gap"]); expect(facts).toHaveLength(1);
  expect(mapClaudeUsageEvent(facts[0])?.metrics.inputTokens).toBe("60");
  expect(mapClaudeUsageEvent(facts[0])?.sourceKey).toBe("claude-message-input-v1:msg_native");
});

test("local command wrappers neither manufacture zero usage nor retire a native stream", () => {
  const facts: unknown[] = [], gaps: string[] = [];
  const collector = createClaudeUsageCollector(value => facts.push(value), () => gaps.push("gap"));
  const local = { ...event(), message: { ...event().message, id: "local-command", model: "<synthetic>", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } };
  expect(mapClaudeUsageEvent(local)).toBeNull();
  collector.observe(local);
  expect(facts).toEqual([]); expect(gaps).toEqual([]);
  const stream = (event: unknown) => collector.observe({ type: "stream_event", parent_tool_use_id: null, event });
  stream({ type: "message_start", message: event().message });
  collector.observe(local);
  stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 40 } });
  stream({ type: "message_stop" });
  expect(facts).toHaveLength(1); expect(gaps).toEqual([]);
  expect(mapClaudeUsageEvent(facts[0])?.metrics.inputTokens).toBe("90");
  collector.observe({ ...local, message: { ...local.message, id: "msg_real_zero", model: "claude-test" } });
  expect(facts).toHaveLength(2);
  expect(mapClaudeUsageEvent(facts[1])?.metrics.inputTokens).toBe("0");
});
