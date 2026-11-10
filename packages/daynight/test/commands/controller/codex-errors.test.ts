import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderEntry, ProviderState } from "../../../src/commands/controller/providers/types.js";
import { parseTimelineEntry } from "../../../src/session/protocol.js";

const nativeError = { message: "Reconnecting... 1/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: "stream disconnected before completion / error decoding response body", misalignment: null };
const notification = (patch: Record<string, unknown> = {}) => ({ method: "error", params: { threadId: "native-thread", turnId: "native-turn", error: nativeError, willRetry: true, ...patch } });
type ErrorEntry = Extract<ProviderEntry, { kind: "error" }>;
const errors = (entries: readonly ProviderEntry[]): ErrorEntry[] => entries.filter((entry): entry is ErrorEntry => entry.kind === "error");
const envelope = (entry: ErrorEntry) => JSON.parse(entry.message) as { message: string; details: string };
const start = async (notifications: readonly unknown[]) => {
  const entries: ProviderEntry[] = [], states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    executable: fileURLToPath(new URL("./fixtures/codex-errors-native.mjs", import.meta.url)),
    env: { ...process.env, CODEX_HOME: fileURLToPath(new URL("./fixtures/no-codex-home", import.meta.url)) },
    onTimeline: entry => { parseTimelineEntry({ ...entry, entrySeq: String(entries.length + 1) }); entries.push(entry); },
    onState: state => states.push(state), onSpawn: () => {} });
  try { await provider.send(textNativeInput(JSON.stringify(notifications)), randomUUID(), null); }
  catch (error) { await provider.close(); throw error; }
  return { provider, entries, states };
};

test("a retry notification retains diagnostics without completing the native turn", async () => {
  const { provider, entries, states } = await start([notification(), { method: "item/agentMessage/delta", params: { threadId: "native-thread", turnId: "native-turn", itemId: "answer", delta: "The response continued." } }]);
  try {
    const notice = errors(entries)[0]!;
    expect(notice.code).toBe("native_retry");
    expect(envelope(notice).message).toBe("Reconnecting... 1/5");
    expect(envelope(notice).details).toContain("responseStreamDisconnected");
    expect(envelope(notice).details).toContain("error decoding response body");
    const before = structuredClone(errors(entries));
    let settled = false;
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(states.at(-1)).toMatchObject({ activity: "working", currentTurnId: "native-turn" });
    await provider.send(textNativeInput(JSON.stringify({ status: "completed", error: null })), randomUUID(), "native-turn");
    await completion;
    expect(states.at(-1)).toMatchObject({ activity: "idle", currentTurnId: null });
    expect(errors(entries)).toEqual(before);
  } finally { await provider.close(); }
});

test("terminal notifications wait for completion and retain both error reports in one row", async () => {
  const terminalError = { ...nativeError, message: "Retry attempts exhausted", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 502 } } };
  const { provider, entries, states } = await start([notification(), notification({ willRetry: false, error: terminalError })]);
  try {
    expect(errors(entries).map(entry => entry.code)).toEqual(["native_retry", "native_turn_error"]);
    const terminal = errors(entries)[1]!;
    let settled = false;
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).catch(error => { settled = true; return error as Error; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(states.at(-1)?.activity).toBe("working");
    await provider.send(textNativeInput(JSON.stringify({ status: "failed", error: { ...terminalError, additionalDetails: null } })), randomUUID(), "native-turn");
    expect(await completion).toBeInstanceOf(Error);
    const final = errors(entries).at(-1)!;
    expect(final.code).toBe("native_turn_error");
    expect(final.entryId).toBe(terminal.entryId);
    expect(BigInt(final.revision)).toBeGreaterThan(BigInt(terminal.revision));
    expect(envelope(final).details).toContain("error decoding response body");
    expect(envelope(final).details).toContain('"status": "failed"');
    expect(new Set(errors(entries).map(entry => entry.entryId)).size).toBe(2);
  } finally { await provider.close(); }
});

test.each([null, { message: "Permission denied", codexErrorInfo: "unauthorized", additionalDetails: null, misalignment: null }])("a failed completion remains visible without an earlier error notification (%j)", async error => {
  const { provider, entries } = await start([]);
  try {
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).catch(error => error as Error);
    await provider.send(textNativeInput(JSON.stringify({ status: "failed", error })), randomUUID(), "native-turn");
    expect(await completion).toBeInstanceOf(Error);
    expect(errors(entries)).toHaveLength(1);
    expect(errors(entries)[0]!.code).toBe("native_turn_error");
    expect(envelope(errors(entries)[0]!).message).toMatch(error ? /Permission denied/ : /failed/i);
  } finally { await provider.close(); }
});

test.each([
  ["missing retry flag", { willRetry: undefined }], ["string retry flag", { willRetry: "true" }], ["numeric retry flag", { willRetry: 1 }],
  ["missing thread", { threadId: undefined }], ["invalid thread", { threadId: 12 }], ["missing turn", { turnId: undefined }],
  ["different turn", { turnId: "older-turn" }], ["invalid turn", { turnId: [] }], ["invalid error", { error: [] }],
] as const)("%s preserves an unknown diagnostic instead of claiming a retry", async (_name, patch) => {
  const { provider, entries, states } = await start([notification(patch)]);
  try {
    expect(errors(entries)).toHaveLength(1);
    expect(errors(entries)[0]!.code).toBe("native_error");
    expect(envelope(errors(entries)[0]!)).toEqual({ message: expect.stringMatching(/\S/), details: expect.stringMatching(/\S/) });
    expect(states.at(-1)).toMatchObject({ activity: "working", currentTurnId: "native-turn" });
  } finally { await provider.close(); }
});

test("explicit foreign-thread errors and completion cannot affect the current turn", async () => {
  const { provider, entries, states } = await start([
    notification({ threadId: "foreign-thread", willRetry: false }),
    { method: "turn/completed", params: { threadId: "foreign-thread", turn: { id: "native-turn", status: "completed", error: null } } },
    { method: "turn/completed", params: { threadId: "native-thread", turn: { id: "older-turn", status: "completed", error: null } } },
    notification(),
  ]);
  try {
    expect(errors(entries).map(entry => entry.code)).toEqual(["native_retry"]);
    expect(states.at(-1)).toMatchObject({ activity: "working", currentTurnId: "native-turn" });
    let settled = false;
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await provider.send(textNativeInput(JSON.stringify({ status: "completed", error: null })), randomUUID(), "native-turn");
    await completion;
  } finally { await provider.close(); }
});

test("long native diagnostics remain bounded, parseable and explicitly truncated", async () => {
  const { provider, entries } = await start([notification({ error: { ...nativeError, additionalDetails: "__LONG_DETAILS__" } })]);
  try {
    const notice = errors(entries)[0]!;
    expect(notice.code).toBe("native_retry");
    expect(notice.message.length).toBeLessThanOrEqual(200_000);
    const parsed = envelope(notice);
    expect(parsed.message).toBe("Reconnecting... 1/5");
    expect(parsed.details).toContain("responseStreamDisconnected");
    expect(parsed.details).toMatch(/truncat/i);
  } finally { await provider.close(); }
});

test("an unrelated completion cannot discard the active turn's terminal diagnostic", async () => {
  const { provider, entries } = await start([
    notification({ willRetry: false }),
    { method: "turn/completed", params: { threadId: "native-thread", turn: { id: "older-turn", status: "failed", error: { message: "Older turn failed" } } } },
  ]);
  try {
    const active = errors(entries)[0]!;
    await provider.send(textNativeInput(JSON.stringify({ status: "failed", error: nativeError })), randomUUID(), "native-turn");
    expect(errors(entries).at(-1)!.entryId).toBe(active.entryId);
    expect(new Set(errors(entries).map(entry => entry.entryId)).size).toBe(2);
  } finally { await provider.close(); }
});

test("invalid non-error thread identity cannot settle the current turn", async () => {
  const { provider, entries, states } = await start([
    { method: "turn/completed", params: { threadId: 42, turn: { id: "native-turn", status: "completed", error: null } } },
    notification(),
  ]);
  try {
    expect(states.at(-1)).toMatchObject({ activity: "working", currentTurnId: "native-turn" });
    expect(errors(entries)[0]!.code).toBe("native_retry");
    let settled = false;
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await provider.send(textNativeInput(JSON.stringify({ status: "completed", error: null })), randomUUID(), "native-turn");
    await completion;
  } finally { await provider.close(); }
});

test("plain native error text remains visible without fabricated retry semantics", async () => {
  const { provider, entries } = await start([notification({ error: "Permission denied", willRetry: undefined })]);
  try {
    expect(errors(entries)[0]!.code).toBe("native_error");
    expect(envelope(errors(entries)[0]!).message).toBe("Permission denied");
    expect(envelope(errors(entries)[0]!).details).toContain("Permission denied");
  } finally { await provider.close(); }
});

test("interruption never reclassifies an earlier retry as recovery", async () => {
  const { provider, entries } = await start([notification()]);
  try {
    const before = structuredClone(errors(entries));
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).catch(error => error as Error);
    await provider.send(textNativeInput(JSON.stringify({ status: "interrupted", error: null })), randomUUID(), "native-turn");
    expect(await completion).toBeInstanceOf(Error);
    expect(errors(entries).filter(entry => entry.code !== "turn_interrupted" && entry.code !== "native_input_missing")).toEqual(before);
    await vi.waitFor(() => expect(errors(entries).some(entry => entry.code === "turn_interrupted")).toBe(true));
  } finally { await provider.close(); }
});

test.each([false, true])("large completed-turn items cannot displace terminal error details (prior notice %s)", async priorNotice => {
  const { provider, entries } = await start(priorNotice ? [notification({ willRetry: false })] : []);
  try {
    const completion = provider.waitForTurn("native-turn", Date.now() + 3000).catch(error => error as Error);
    await provider.send(textNativeInput(JSON.stringify({ status: "failed", itemsView: "summary", items: [{ type: "agentMessage", id: "long-answer", text: "Long assistant output. ".repeat(2_000), phase: null, memoryCitation: null, delivery: null, questions: null }],
      error: { message: "Terminal request failed", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } }, additionalDetails: "terminal transport diagnostics", misalignment: null } })), randomUUID(), "native-turn");
    expect(await completion).toBeInstanceOf(Error);
    const final = errors(entries).at(-1)!;
    expect(final.code).toBe("native_turn_error");
    expect(envelope(final).message).toBe("Terminal request failed");
    expect(envelope(final).details).toContain("responseTooManyFailedAttempts");
    expect(envelope(final).details).toContain("terminal transport diagnostics");
    expect(final.message.length).toBeLessThanOrEqual(200_000);
  } finally { await provider.close(); }
});

test("long native messages and details have independent diagnostic budgets", async () => {
  const { provider, entries } = await start([notification({ error: { message: "Long native message. ".repeat(2_000),
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: "Underlying transport failure. ".repeat(2_000), misalignment: null } })]);
  try {
    const notice = errors(entries)[0]!, parsed = envelope(notice);
    expect(notice.code).toBe("native_retry");
    expect(parsed.details).toContain("responseStreamDisconnected");
    expect(parsed.details).toContain("Underlying transport failure.");
    expect(parsed.details).toContain("Long native message.");
    expect(parsed.details).toMatch(/truncat/i);
    expect(notice.message.length).toBeLessThanOrEqual(200_000);
  } finally { await provider.close(); }
});

test.each([undefined, null])("legacy notification fields survive a missing native error object (%s)", async error => {
  const { provider, entries } = await start([notification({ error, message: "Unexpected legacy diagnostic", code: "legacy_failure", context: "native diagnostic payload" })]);
  try {
    const notice = errors(entries)[0]!, parsed = envelope(notice);
    expect(notice.code).toBe("native_error");
    expect(parsed.message).toBe("Unexpected legacy diagnostic");
    expect(parsed.details).toContain("legacy_failure");
    expect(parsed.details).toContain("native diagnostic payload");
  } finally { await provider.close(); }
});

test("a large unknown notification field cannot hide its legacy error code", async () => {
  const { provider, entries } = await start([notification({ error: undefined, message: "Legacy request failed", legacyPayload: "Large legacy payload. ".repeat(2_000), code: "legacy_failure" })]);
  try {
    const notice = errors(entries)[0]!, parsed = envelope(notice);
    expect(notice.code).toBe("native_error");
    expect(parsed.details.includes("legacy_failure")).toBe(true);
    expect(parsed.details).toContain("Large legacy payload.");
    expect(parsed.details.length).toBeLessThan(12_000);
    expect(parsed.details).toMatch(/truncat/i);
  } finally { await provider.close(); }
});
