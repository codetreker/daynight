import { expect, test } from "vitest";
import { copilotUsageProviderVersion, mapCopilotUsageEvent } from "../../../src/commands/controller/providers/copilot-usage.js";

const event = () => ({ id: "10000000-0000-4000-8000-000000000001", type: "assistant.usage", timestamp: "2026-11-18T03:00:00.123456Z", data: { model: "model", inputTokens: 12000, outputTokens: 400, cacheReadTokens: 10000, cacheWriteTokens: 0, reasoningTokens: 80 } });

test("Copilot event plane preserves stable sources and known output without adding uncertain input/cache", () => {
  const native = { ...event(), agentId: "native-child", secret: "excluded", data: { ...event().data, apiCallId: "not-a-required-identity", prompt: "excluded" } };
  const mapped = mapCopilotUsageEvent(native)!;
  expect(mapped.sourceKey).toBe(`copilot-event-v1:${native.id}`);
  expect(mapped.metrics).toEqual({ inputTokens: null, outputTokens: "400", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: "80", totalTokens: null, providerTotalTokens: null });
  expect(mapped.nativeMetrics).toEqual({ inputTokens: "12000", outputTokens: "400", cacheReadTokens: "10000", cacheWriteTokens: "0", reasoningTokens: "80", agentId: "native-child", agentType: "unknown" });
  expect(mapped).toMatchObject({ finality: "final", sourceRevision: "1", aggregationRole: "counted", nativeCallId: null, nativeTurnId: null, observedAt: native.timestamp });
  expect(mapped).toEqual(mapCopilotUsageEvent(structuredClone(native)));
  expect(JSON.stringify(mapped)).not.toContain("excluded");
  expect(mapCopilotUsageEvent({ ...native, id: "10000000-0000-4000-8000-000000000002" })!.sourceKey).not.toBe(mapped.sourceKey);
});

test("Copilot unknown metrics remain null and genuine zero remains known", () => {
  const mapped = mapCopilotUsageEvent({ ...event(), data: { model: "model", outputTokens: 0 } })!;
  expect(mapped.metrics.outputTokens).toBe("0");
  expect(mapped.metrics.reasoningTokens).toBeNull();
  expect(mapped.nativeMetrics.inputTokens).toBeNull();
  expect(mapped.nativeMetrics).not.toHaveProperty("agentId");
});

test.each([Number.MAX_SAFE_INTEGER + 1, -1, 0.1, NaN, Infinity, "400"])("Copilot refuses unrepresentable native token %s", value => {
  expect(() => mapCopilotUsageEvent({ ...event(), data: { ...event().data, outputTokens: value } })).toThrow("native_integer_unrepresentable");
});

test("Copilot refuses missing/unstable identity and inconsistent native metrics", () => {
  for (const patch of [{ id: "call" }, { id: "10000000-0000-5000-8000-000000000001" }, { timestamp: "now" }, { agentId: "" }, { data: { ...event().data, model: "" } }, { data: { ...event().data, model: "\ud800" } }, { data: { ...event().data, outputTokens: 2, reasoningTokens: 3 } }]) {
    expect(() => mapCopilotUsageEvent({ ...event(), ...patch })).toThrow("collector_failed");
  }
});

test("Copilot cumulative, context and shutdown events cannot create measurements", () => {
  for (const type of ["session.usage_info", "session.shutdown", "session.usage_checkpoint", "assistant.idle"]) expect(mapCopilotUsageEvent({ ...event(), type })).toBeNull();
});

test("Copilot qualification identity includes exact SDK and runtime versions", () => {
  expect(copilotUsageProviderVersion("1.0.11", "1.0.105")).toBe("1.0.11/1.0.105");
  expect(copilotUsageProviderVersion("1.0.12", "1.0.105")).toBeNull();
  expect(copilotUsageProviderVersion("1.0.11", undefined)).toBeNull();
  expect(copilotUsageProviderVersion("1.0.11", "latest")).toBeNull();
});
