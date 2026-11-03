import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
import { parseSourceEvent } from "../../../src/session/controller-protocol.js";

const sleep = { type: "sleep", id: "sleep-call", durationMs: 50_000, startedAtMs: 1793708507841 };
const setup = () => {
  const entries: ProviderEntry[] = [];
  return { entries, projection: new CodexProjection("native-thread", entry => {
    expect(() => parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: entry })).not.toThrow();
    entries.push(entry);
  }) };
};

test("native sleep start, completion and history share one tool identity without invented elapsed time", () => {
  const live = setup(), history = setup();
  live.projection.item(sleep, false);
  // New input can wake the wait before the requested duration elapses.
  const completed = { ...sleep, completedAtMs: sleep.startedAtMs + 2_000 };
  live.projection.item(completed, true);
  history.projection.item(completed, true);
  expect(live.entries[0]).toEqual({ entryId: expect.any(String), revision: "1", kind: "tool_call", callId: "sleep-call", name: "clock.sleep", input: "Wait up to 50 seconds (requested)", output: [], status: "running", truncated: false });
  expect(live.entries[1]).toEqual({ ...live.entries[0], status: "completed" });
  expect(history.entries).toEqual([live.entries[1]]);
});

test.each([[1_000, "1 second"], [1_500, "1.5 seconds"], [50_000, "50 seconds"]])("sleep request %s is described as %s", (durationMs, expected) => {
  const { entries, projection } = setup();
  projection.item({ ...sleep, durationMs }, true);
  expect(entries[0]).toMatchObject({ kind: "tool_call", input: `Wait up to ${expected} (requested)`, output: [] });
});

test.each([undefined, null, 0, -1, NaN, Infinity, "50000"])("invalid sleep duration %s remains a wait", durationMs => {
  const { entries, projection } = setup();
  projection.item({ ...sleep, durationMs }, true);
  expect(entries[0]).toMatchObject({ kind: "tool_call", name: "clock.sleep", input: "Wait", status: "completed", output: [] });
});

test("unknown native items retain an explicit diagnostic", () => {
  const { entries, projection } = setup();
  projection.item({ id: "unknown", type: "futureNativeItem" }, true);
  expect(entries[0]).toMatchObject({ kind: "error", code: "unsupported_native_item" });
});

test("stdio sleep notifications and resumed native history reach the same timeline row", async () => {
  const live: ProviderEntry[] = [], history: ProviderEntry[] = [];
  const options = { cwd: process.cwd(), model: null, args: [], executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onState: () => {}, onSpawn: () => {}, env: { ...process.env, CODEX_TEST_SLEEP: "1" } };
  const provider = await openCodexProvider({ ...options, resumeNativeSessionId: null, onTimeline: entry => live.push(entry) });
  try {
    const receipt = await provider.send("sleep", randomUUID(), null);
    await provider.waitForTurn(receipt.turnId!, Date.now() + 2_000);
  } finally { await provider.close(); }
  const resumed = await openCodexProvider({ ...options, resumeNativeSessionId: "native-thread", onTimeline: entry => history.push(entry) });
  try {
    const tools = live.filter(entry => entry.kind === "tool_call");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: "clock.sleep", status: "running" });
    expect(tools[1]).toEqual({ ...tools[0], status: "completed" });
    expect(history.filter(entry => entry.kind === "tool_call")).toEqual([tools[1]]);
    expect([...live, ...history].some(entry => entry.kind === "error")).toBe(false);
  } finally { await resumed.close(); }
});
