import { describe, expect, it } from "vitest";
import { botHistoryWindowEntryDigest, parseBotHistoryCheckpoint, parseBotHistoryCheckpointReceipt, parseBotHistoryWindowPage, parseBotHistoryWindowRequest, type BotHistoryWindowPage } from "../../src/session/bot-history-window.js";
import { parseControllerMessage, parseRelayMessage } from "../../src/session/controller-protocol.js";

const id = "00000000-0000-4000-8000-000000000001";
const boundary = () => ({ sessionId: id, testExecutionId: id, executionGeneration: "9007199254740993", connectionEpoch: "2", botHistoryWindowVersion: 1 as const, historyEpoch: id, windowRevision: "5", retainedFromSeq: "9007199254740993", throughSeq: "9007199254740995", earlierHistoryUnavailable: true });
const entry = () => ({ entryId: id, entrySeq: "9007199254740993", revision: "2", kind: "assistant_message" as const, preview: "<你好🙂>", truncated: true, originalBytes: null, previewBytes: "12", omissionReason: "preview_budget", omittedEntryCount: 0, resourceIds: [] as string[], tool: null });
const page = (): BotHistoryWindowPage => ({ ...boundary(), kind: "bot_history_window", items: [entry()], hasEarlierHistory: false, beforeCursor: null, nextCursor: "next" });
const fence = { sessionId: id, testExecutionId: id, executionGeneration: "9007199254740993", connectionEpoch: "2" };

describe("Bot history window protocol", () => {
  it("preserves int64 boundaries, preview omission and cross-language canonical digest", async () => {
    expect(parseBotHistoryWindowPage(page())).toEqual(page());
    expect(await botHistoryWindowEntryDigest(entry())).toBe("8a3bb9125548e65502e4948f8f14adf64e2e59c3197b719cd6b948b226d84b84");
    const response = { ...fence, protocol: "daynight.session.v1", type: "content_response", requestId: id, sourceThrough: "99", result: page(), error: null };
    expect(parseControllerMessage(response)).toEqual(response);
  });

  it.each([
    { previewBytes: "6" }, { originalBytes: "11" }, { omissionReason: null }, { omittedEntryCount: 1 },
    { truncated: false }, { preview: "a".repeat(32 * 1024 + 1), previewBytes: "32769" },
    { preview: "\ud800", previewBytes: "3" }, { resourceIds: [id, id] }, { revision: "0" },
    { body: "not a complete body" }, { contentRef: null },
  ])("rejects malformed or ambiguous preview %j", (change) => {
    expect(() => parseBotHistoryWindowPage({ ...page(), items: [{ ...entry(), ...change }] })).toThrow();
  });

  it.each([
    { retainedFromSeq: "9007199254740994" }, { throughSeq: "9007199254740992" }, { items: [entry(), entry()] },
    { hasEarlierHistory: true }, { historyEpoch: "" }, { botHistoryWindowVersion: 2 }, { claimId: id },
    { windowRevision: "0" }, { retainedFromSeq: 9007199254740993 },
  ])("rejects invalid window boundaries %j", (change) => {
    expect(() => parseBotHistoryWindowPage({ ...page(), ...change })).toThrow();
  });

  it("distinguishes evicted-empty history from an initial empty session", () => {
    const empty = { ...page(), items: [], retainedFromSeq: null };
    expect(parseBotHistoryWindowPage(empty).earlierHistoryUnavailable).toBe(true);
    expect(() => parseBotHistoryWindowPage({ ...empty, earlierHistoryUnavailable: false })).toThrow();
    const initial = { ...empty, throughSeq: null, earlierHistoryUnavailable: false };
    expect(parseBotHistoryWindowPage(initial)).toEqual(initial);
    expect(() => parseBotHistoryWindowPage({ ...initial, earlierHistoryUnavailable: true })).toThrow();
  });

  it("validates complete previews, tool summaries and actual encoded page size", () => {
    const complete = { ...entry(), truncated: false, originalBytes: "12", omissionReason: null };
    expect(parseBotHistoryWindowPage({ ...page(), items: [complete] }).items[0]).toEqual(complete);
    const summary = { ...entry(), kind: "tool_call", omittedEntryCount: 3 };
    expect(parseBotHistoryWindowPage({ ...page(), items: [summary] }).items[0]).toEqual(summary);
    const items = Array.from({ length: 10 }, (_, index) => ({ ...entry(), entryId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, entrySeq: String(index + 1), preview: "a".repeat(32 * 1024), previewBytes: "32768" }));
    expect(() => parseBotHistoryWindowPage({ ...page(), retainedFromSeq: "1", throughSeq: "10", items })).toThrow();
  });

  it("retains structured tool facts and explicit unknown fields within UTF-8 limits", () => {
    const tool = { toolName: "shell", command: "echo 你好", cwd: null, status: "completed", exitCode: -1 };
    const item = { ...entry(), kind: "tool_call", tool };
    expect(parseBotHistoryWindowPage({ ...page(), items: [item] }).items[0]?.tool).toEqual(tool);
    for (const change of [{ command: "🙂".repeat(2049) }, { cwd: "x".repeat(4097) }, { toolName: "x".repeat(257) }, { status: "x".repeat(257) }, { exitCode: 0.1 }, { exitCode: 2147483648 }, { cwd: undefined }]) {
      expect(() => parseBotHistoryWindowPage({ ...page(), items: [{ ...item, tool: { ...tool, ...change } }] })).toThrow();
    }
    expect(() => parseBotHistoryWindowPage({ ...page(), items: [{ ...entry(), tool }] })).toThrow();
    expect(() => parseBotHistoryWindowPage({ ...page(), items: [{ ...entry(), tool: undefined }] })).toThrow();
  });

  it("validates complete checkpoint references without coupling source and entry counters", async () => {
    const checkpoint = { ...boundary(), sourceEpoch: "00000000-0000-4000-8000-000000000002", sourceThrough: "99", entries: [{ entryId: id, entrySeq: entry().entrySeq, revision: "2", sha256: await botHistoryWindowEntryDigest(entry()), resourceIds: [id], imageOccurrences: [] }] };
    expect(parseBotHistoryCheckpoint(checkpoint)).toEqual(checkpoint);
    const occurrence = { imageId: id, entryId: id, container: "content", partId: id, sourceRevision: "2", sourceTextSha256: "a".repeat(64), callId: null, sourceKey: "image" };
    const withImage = { ...checkpoint, entries: [{ ...checkpoint.entries[0], imageOccurrences: [occurrence] }] };
    expect(parseBotHistoryCheckpoint(withImage)).toEqual(withImage);
    for (const occurrences of [[{ ...occurrence, entryId: "00000000-0000-4000-8000-000000000002" }], [occurrence, occurrence], [{ ...occurrence, partId: null }], null]) {
      expect(() => parseBotHistoryCheckpoint({ ...checkpoint, entries: [{ ...checkpoint.entries[0], imageOccurrences: occurrences }] })).toThrow();
    }
    expect(() => parseBotHistoryCheckpoint({ ...checkpoint, entries: [{ ...checkpoint.entries[0], entrySeq: "9007199254740994" }] })).toThrow();
    expect(() => parseBotHistoryCheckpoint({ ...checkpoint, entries: null })).toThrow();
    expect(() => parseBotHistoryCheckpoint({ ...checkpoint, entries: [checkpoint.entries[0], checkpoint.entries[0]] })).toThrow();
    const empty = { ...checkpoint, retainedFromSeq: null, entries: [] };
    expect(parseBotHistoryCheckpoint(empty)).toEqual(empty);
    const receipt = { ...boundary(), sourceEpoch: "00000000-0000-4000-8000-000000000002", sourceThrough: "99", cleanupPending: true };
    expect(parseBotHistoryCheckpointReceipt(receipt)).toEqual(receipt);
    expect(() => parseBotHistoryCheckpointReceipt({ ...receipt, cleanupPending: undefined })).toThrow();
    const { sourceEpoch: _checkpointSource, ...missingCheckpointSource } = checkpoint;
    const { sourceEpoch: _receiptSource, ...missingReceiptSource } = receipt;
    expect(() => parseBotHistoryCheckpoint(missingCheckpointSource)).toThrow();
    expect(() => parseBotHistoryCheckpointReceipt(missingReceiptSource)).toThrow();
    for (const sourceEpoch of [undefined, null, "", "old-source", "AAAAAAAA-0000-4000-8000-000000000002", 2]) {
      expect(() => parseBotHistoryCheckpoint({ ...checkpoint, sourceEpoch })).toThrow();
      expect(() => parseBotHistoryCheckpointReceipt({ ...receipt, sourceEpoch })).toThrow();
    }
  });

  it.each(["tail", "before", "changes"] as const)("keeps %s reads in a separate request variant", (mode) => {
    const request = { kind: "bot_history_window", historyEpoch: id, mode, cursor: mode === "tail" ? null : "position", limit: 50, responseOverhead: 10 };
    expect(parseBotHistoryWindowRequest(request)).toEqual(request);
    expect(() => parseBotHistoryWindowRequest({ ...request, cursor: mode === "tail" ? "position" : null })).toThrow();
    expect(() => parseBotHistoryWindowRequest({ ...request, limit: 201 })).toThrow();
    expect(() => parseBotHistoryWindowRequest({ ...request, responseOverhead: 256 * 1024 })).toThrow();
    const message = { ...fence, type: "content_request", protocol: "daynight.session.v1", requestId: id, ...request };
    expect(parseRelayMessage(message)).toEqual(message);
    const { testExecutionId: _testExecutionId, ...taskMessage } = message;
    expect(() => parseRelayMessage({ ...taskMessage, claimId: id })).toThrow();
  });

  it("negotiates only explicit Bot capability and retains legacy hello shape", () => {
    const hello = { type: "hello", protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: id, testExecutionId: id, executionGeneration: "1", controllerId: id, controllerInstanceId: id, provider: "codex", sourceEpoch: id, lastAckedSourceSeq: "0" };
    expect(parseControllerMessage(hello)).toEqual(hello);
    expect(parseControllerMessage({ ...hello, botHistoryWindowVersion: 1 })).toEqual({ ...hello, botHistoryWindowVersion: 1 });
    for (const bad of [null, 0, 2, "1"]) expect(() => parseControllerMessage({ ...hello, botHistoryWindowVersion: bad })).toThrow();
    const { testExecutionId: _testExecutionId, ...taskHello } = hello;
    expect(() => parseControllerMessage({ ...taskHello, claimId: id, botHistoryWindowVersion: 1 })).toThrow();
  });
});
