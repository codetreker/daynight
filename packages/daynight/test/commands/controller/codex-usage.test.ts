import { expect, test } from "vitest";
import { codexResponseIdentity, codexUsageProviderVersion, mapCodexUsageEvent } from "../../../src/commands/controller/providers/codex-usage.js";

test.each(["0.168.0", "0.169.0", "0.169.1", "0.169.2", "0.170.0", "1.2.3-beta.1+build.2"])("recognizes the connected Codex %s handshake", version => {
  expect(codexUsageProviderVersion({ userAgent: `daynight/${version} (Windows 11; x86_64)` })).toBe(version);
});

const event = (usage: unknown = { inputTokens: 34327, outputTokens: 229, totalTokens: 34556, cachedInputTokens: 27352, cacheWriteInputTokens: 6972, reasoningOutputTokens: 8 }) => ({
  method: "rawResponse/completed", params: { threadId: "thread", turnId: "turn", responseId: "response", usage },
});

test.each(["thread/tokenUsage/updated", "token_count", "turn/completed"])("does not count %s snapshots or lifecycle events", method => {
  expect(mapCodexUsageEvent({ ...event(), method })).toBeNull();
});

test("maps one real response without adding cache or reasoning subsets twice", () => {
  expect(mapCodexUsageEvent(event())).toMatchObject({
    aggregationRole: "counted", nativeTurnId: "turn", model: null,
    metrics: { inputTokens: "34327", outputTokens: "229", totalTokens: "34556", providerTotalTokens: "34556", cacheReadTokens: "27352", cacheWriteTokens: null, reasoningTokens: "8" },
    nativeMetrics: { cacheWriteInputTokens: "6972" },
    reasonCodes: expect.arrayContaining(["model_unknown", "native_recovery_gap", "subagent_scope_unknown"]),
  });
});

test("preserves unavailable usage and ambiguous native zero-valued details as null", () => {
  expect(mapCodexUsageEvent(event(null))?.metrics).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, providerTotalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
  expect(mapCodexUsageEvent(event({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }))?.metrics).toMatchObject({ inputTokens: "0", outputTokens: "0", totalTokens: "0", cacheReadTokens: null, reasoningTokens: null });
});

test("hashes complete long response IDs in their native thread namespace", () => {
  const long = "resp_" + "a".repeat(1200), input = event();
  input.params.responseId = long;
  const mapped = mapCodexUsageEvent(input)!;
  expect(mapped.nativeCallId).toMatch(/^[a-f0-9]{64}$/);
  expect(mapped.sourceKey).toBe(`codex-response-v1:${codexResponseIdentity("thread", long)}`);
  expect(mapCodexUsageEvent(input)?.sourceKey).toBe(mapped.sourceKey);
  expect(codexResponseIdentity("another-thread", long)).not.toBe(mapped.nativeCallId);
  expect(codexResponseIdentity("thread", long + "b")).not.toBe(mapped.nativeCallId);
});

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "12"])("refuses unrepresentable native tokens %s", inputTokens => {
  expect(() => mapCodexUsageEvent(event({ inputTokens }))).toThrow("native_integer_unrepresentable");
});

test.each([
  { inputTokens: 10, outputTokens: 2, totalTokens: 13 },
  { inputTokens: 10, cachedInputTokens: 11 },
  { outputTokens: 2, reasoningOutputTokens: 3 },
])("refuses inconsistent native token relationships %j", usage => {
  expect(() => mapCodexUsageEvent(event(usage))).toThrow("collector_failed");
});

test.each(["", "bad\nidentity", "\ud800", "x".repeat(65537)])("refuses invalid response identities", responseId => {
  const input = event(); input.params.responseId = responseId;
  expect(() => mapCodexUsageEvent(input)).toThrow("collector_failed");
});
test.each([...["01.2.3", "1.2.3-01", "1.2.3+a+b", "1.2.3+" + "a".repeat(128)].map(version => ({ userAgent: `daynight/${version} (Windows)` })), {}, null, { userAgent: "codex/0.169.0 (Windows)" }, { userAgent: "daynight/unknown (Windows)" }, { userAgent: "daynight/0.169 (Windows)" }])("does not assign a version to a malformed handshake %j", input => {
  expect(codexUsageProviderVersion(input)).toBeNull();
});
