import { expect, test } from "vitest";
import { sessionDisplayEntry, sessionWireBytes } from "../../../src/commands/controller/wire-display.js";
import { parseSourceEvent } from "../../../src/session/controller-protocol.js";
import { parseStoredTimelineEntry, type TimelineEntry } from "../../../src/session/protocol.js";

test("an oversized individual tool field gets a valid display placeholder without changing its original", () => {
  const text = "x".repeat(1_048_577);
  const entryId = "11111111-1111-4111-8111-111111111111";
  const entry: TimelineEntry = { entryId, entrySeq: "7", revision: "2", kind: "tool_call", callId: "call-1", name: "shell", input: "command", output: [{ type: "text", text }], status: "completed", truncated: false };
  expect(parseStoredTimelineEntry(entry)).toEqual(entry);
  expect(sessionWireBytes(entry)).toBeLessThan(1_400_000);
  expect(() => parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: entry })).toThrow();
  const display = sessionDisplayEntry(entry);
  expect(display).toMatchObject({ entryId, entrySeq: "7", revision: "2", kind: "error", code: "display_budget_exceeded" });
  expect(() => parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: display })).not.toThrow();
  expect(entry.output).toEqual([{ type: "text", text }]);
  expect(entry.kind).toBe("tool_call");
  expect(entry.truncated).toBe(false);
});
