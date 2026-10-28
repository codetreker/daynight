import { expect, test } from "vitest";
import { CodexProjection, limited } from "../../../src/commands/controller/providers/projection.js";
import { parseSourceEvent } from "../../../src/session/controller-protocol.js";
test.each([199998, 199999, 200000])("Unicode truncation at %s retains valid wire text in live and historical projection", boundary => {
  const text = "a".repeat(boundary) + "😀" + "tail";
  expect(limited(text).isWellFormed()).toBe(true);
  const projection = new CodexProjection("session", entry => expect(() => parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: entry })).not.toThrow());
  projection.item({ id: "user", type: "userMessage", content: [{ type: "text", text }] }, true);
  projection.item({ id: "assistant", type: "agentMessage", text }, true);
  projection.delta("live", text, "assistant_message");
});
