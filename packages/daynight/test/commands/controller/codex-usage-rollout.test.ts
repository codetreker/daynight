import { afterEach, beforeEach, expect, test } from "vitest";
import { appendFileSync } from "node:fs";
import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexUsageRollout } from "../../../src/commands/controller/providers/codex-usage-rollout.js";
import { mapCodexUsageEvent } from "../../../src/commands/controller/providers/codex-usage.js";

let root: string, file: string;
const nativeSessionId = "00000000-0000-4000-8000-000000000001", turnId = "turn";
beforeEach(async () => {
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  root = await realpath(await mkdtemp(join(process.cwd(), ".tmp", "codex-usage-rollout-")));
  file = join(root, "original.jsonl");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const line = (entry: unknown) => JSON.stringify(entry) + "\n";
const metadata = (patch: Record<string, unknown> = {}) => ({ type: "session_meta", payload: { id: nativeSessionId, cwd: root, cli_version: "0.169.0", ...patch } });
const usageRecord = (responseId = "response", patch: Record<string, unknown> = {}) => ({ type: "token_usage_record", payload: {
  thread_id: nativeSessionId, session_id: nativeSessionId, turn_id: turnId, root_turn_id: turnId, response_id: responseId,
  usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 40, cache_write_input_tokens: 60, reasoning_output_tokens: 5 }, ...patch,
} });
const collector = (observe?: (event: unknown) => void) => {
  const events: unknown[] = [], gaps: string[] = [];
  const reader = new CodexUsageRollout({ file, cwd: root, nativeSessionId, observe: event => { events.push(event); observe?.(event); }, gap: reason => { gaps.push(reason); } });
  return { reader, events, gaps };
};

test("reads exact per-response records including an incomplete response after a failed turn", async () => {
  await writeFile(file, line(metadata()) + line({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } })
    + line({ type: "event_msg", payload: { type: "error", message: "response incomplete" } }) + line(usageRecord())
    + line({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }));
  const { reader, events, gaps } = collector(); await reader.drain(); await reader.scan();
  expect(events).toHaveLength(1); expect(gaps).toEqual([]);
  expect(events[0]).toMatchObject({ method: "rawResponse/completed", params: { threadId: nativeSessionId, turnId, responseId: "response", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 40, cacheWriteInputTokens: 60, reasoningOutputTokens: 5 } } });
  expect(mapCodexUsageEvent(events[0])?.metrics.totalTokens).toBe("110");
});

test.each([{ id: "another-thread" }, { cli_version: "0.168.0" }, { forked_from_id: "parent" }, { source: { subagent: { parent_thread_id: "parent" } } }])("rejects a mismatched or inherited original metadata %j", async patch => {
  await writeFile(file, line(metadata(patch)) + line(usageRecord()));
  const { reader, events, gaps } = collector(); await reader.scan();
  expect(events).toEqual([]); expect(gaps).toEqual(["native_recovery_gap"]);
});

test("rejects a rollout whose recorded workspace belongs elsewhere", async () => {
  const other = join(root, "other"); await mkdir(other);
  await writeFile(file, line(metadata({ cwd: other })) + line(usageRecord()));
  const { reader, events, gaps } = collector(); await reader.scan();
  expect(events).toEqual([]); expect(gaps).toEqual(["native_recovery_gap"]);
});

test.each([{ thread_id: "other" }, { session_id: "other" }, { root_turn_id: "parent-turn" }])("does not attribute foreign response records %j", async patch => {
  await writeFile(file, line(metadata()) + line(usageRecord("response", patch)));
  const { reader, events, gaps } = collector(); await reader.scan();
  expect(events).toEqual([]); expect(gaps).toEqual(["native_recovery_gap"]);
});

test("rejects a symlink even when its target contains valid native records", async () => {
  const target = join(root, "target.jsonl"); await writeFile(target, line(metadata()) + line(usageRecord()));
  await symlink(target, file, "file");
  const { reader, events, gaps } = collector(); await reader.scan();
  expect(events).toEqual([]); expect(gaps).toEqual(["native_recovery_gap"]);
});

test("retries a partial final record intact without re-emitting its preceding response", async () => {
  const next = line(usageRecord("next")), split = Math.floor(next.length / 2);
  await writeFile(file, line(metadata()) + line(usageRecord()) + next.slice(0, split));
  const { reader, events, gaps } = collector(); await reader.scan();
  expect(events).toHaveLength(1); expect(gaps).toEqual([]);
  await appendFile(file, next.slice(split)); await reader.scan(); await reader.scan();
  expect(events).toHaveLength(2); expect(gaps).toEqual([]);
  expect(events[1]).toMatchObject({ params: { responseId: "next" } });
});

test("advances beyond a single native body larger than the scan budget", async () => {
  await writeFile(file, line(metadata()) + line({ type: "response_item", payload: { type: "message", body: "x".repeat(17 * 1024 * 1024) } }) + line(usageRecord()));
  const { reader, events, gaps } = collector(); await reader.drain();
  expect(events).toHaveLength(1); expect(gaps).toEqual([]);
}, 15_000);

test("drain waits for an in-flight scan and then reads the tail added after its snapshot", async () => {
  await writeFile(file, line(metadata()) + line(usageRecord()));
  let draining: Promise<void> | undefined;
  const { reader, events, gaps } = collector(() => {
    if (events.length !== 1) return;
    appendFileSync(file, line(usageRecord("tail")));
    draining = reader.drain();
  });
  await reader.scan(); expect(draining).toBeDefined(); await draining;
  expect(events).toHaveLength(2); expect(events[1]).toMatchObject({ params: { responseId: "tail" } }); expect(gaps).toEqual([]);
});
