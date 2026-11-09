import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";

const open = async (scenario: string, resumed = false, journal?: { hasTimelineEntry(id: string): boolean; projectTimeline(entry: ProviderEntry): unknown }) => {
  const entries: ProviderEntry[] = [], observed: string[] = [];
  let child!: ChildProcess;
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: resumed ? "native-thread" : null,
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), env: { ...process.env, CODEX_TEST_INTERRUPT: scenario },
    ...(journal ? { hasTimelineEntry: (id: string) => journal.hasTimelineEntry(id) } : {}),
    onTimeline: entry => { entries.push(entry); journal?.projectTimeline(entry); }, onInputObserved: id => observed.push(id), onState: () => {}, onSpawn: value => { child = value; } });
  return { provider, entries, observed, child };
};
const rows = (entries: readonly ProviderEntry[]) => [...new Map(entries.map(entry => [entry.entryId, entry])).values()];
const markers = (entries: readonly ProviderEntry[]) => rows(entries).filter(entry => entry.kind === "error" && entry.code === "turn_interrupted");

test.each(["ack-first", "completion-first"])("Codex %s interruption has one stable terminal marker", async scenario => {
  const live = await open(scenario);
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await live.provider.cancel(sent.turnId!);
    expect(markers(live.entries)).toHaveLength(1);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(1);
    const restored = await open(scenario, true);
    try { expect(markers(restored.entries)).toEqual(markers(live.entries)); }
    finally { await restored.provider.close(); }
  } finally { await live.provider.close(); }
});

test("interrupted completion recovers native user items omitted from individual notifications", async () => {
  const live = await open("completion-items");
  try {
    const operationId = randomUUID();
    const sent = await live.provider.send("cancel", operationId, null);
    await live.provider.cancel(sent.turnId!);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toMatchObject([{ content: [{ type: "text", text: "cancel" }] }]);
    expect(live.observed).toContain(operationId);
    expect(markers(live.entries)).toHaveLength(1);
  } finally { await live.provider.close(); }
});

test("interruption before native input recording retains submitted text without inventing receipt evidence", async () => {
  const live = await open("missing-user");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await live.provider.cancel(sent.turnId!);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toMatchObject([{ content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("cancel") })]) }]);
    await vi.waitFor(() => expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(true));
    expect(live.observed).toEqual([]);
    expect(markers(live.entries)).toHaveLength(1);
  } finally { await live.provider.close(); }
});

test("paginated native turns restore empty interruptions in their original order", async () => {
  const history = await open("paged-history", true);
  try {
    const all = rows(history.entries);
    expect(markers(all)).toHaveLength(2);
    expect(all.filter(entry => entry.kind === "user_message")).toHaveLength(1);
    expect(all.map(entry => entry.kind === "error" ? entry.code : entry.kind)).toEqual(["native_input_missing", "turn_interrupted", "user_message", "turn_interrupted"]);
  } finally { await history.provider.close(); }
});

test.each(["completed", "failed"])("a %s turn is never labeled interrupted after an interrupt request", async scenario => {
  const live = await open(scenario);
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await live.provider.cancel(sent.turnId!);
    expect(markers(live.entries)).toEqual([]);
    expect(live.entries.filter(entry => entry.kind === "error" && entry.code === "native_turn_error")).toHaveLength(scenario === "failed" ? 1 : 0);
  } finally { await live.provider.close(); }
});

test("missing live input is recovered from full native history without a duplicate user row", async () => {
  const live = await open("history-user");
  try {
    const operationId = randomUUID();
    const sent = await live.provider.send("cancel", operationId, null);
    await live.provider.cancel(sent.turnId!);
    await vi.waitFor(() => expect(live.observed).toContain(operationId));
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toMatchObject([{ content: [{ type: "text", text: "cancel" }] }]);
    expect(markers(live.entries)).toHaveLength(1);
    expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(false);
  } finally { await live.provider.close(); }
});

test("native completion confirms cancellation without waiting for input-history recovery", async () => {
  const live = await open("history-delayed");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await live.provider.cancel(sent.turnId!);
    expect(markers(live.entries)).toHaveLength(1);
    expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(false);
    await vi.waitFor(() => expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(true));
  } finally { await live.provider.close(); }
});

test("an unreadable completed turn retains input with an explicit unverified-recording diagnostic", async () => {
  const live = await open("history-read-failure");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await live.provider.cancel(sent.turnId!);
    await vi.waitFor(() => expect(rows(live.entries)).toContainEqual(expect.objectContaining({ code: "native_input_missing", message: expect.stringContaining("could not be verified") })));
    expect(live.observed).toEqual([]);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(1);
  } finally { await live.provider.close(); }
});

test("history failures are not silently downgraded to item-only recovery", async () => {
  await expect(open("history-read-failure", true)).rejects.toThrow("History unavailable");
});

test("a late start receipt cannot resurrect an already interrupted turn", async () => {
  const live = await open("late-receipt");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await expect(live.provider.waitForTurn(sent.turnId!, Date.now() + 500)).rejects.toThrow("interrupted");
    // A new idle send is admitted only if the late receipt left the ended turn idle.
    await expect(live.provider.send("next", randomUUID(), null)).resolves.toMatchObject({ disposition: "started" });
    expect(markers(live.entries)).toHaveLength(1);
  } finally { await live.provider.close(); }
});

test("a completion from another thread cannot create an interruption marker", async () => {
  const live = await open("foreign-thread");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    expect(markers(live.entries)).toEqual([]);
    await live.provider.cancel(sent.turnId!);
    expect(markers(live.entries)).toHaveLength(1);
  } finally { await live.provider.close(); }
});

test("an interrupted turn retains an unrecorded steer without duplicating its recorded initial input", async () => {
  const live = await open("steer-missing");
  try {
    const first = randomUUID(), second = randomUUID();
    const sent = await live.provider.send("cancel", first, null);
    await live.provider.send("follow-up", second, sent.turnId!);
    await live.provider.cancel(sent.turnId!);
    await vi.waitFor(() => expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(true));
    const users = rows(live.entries).filter(entry => entry.kind === "user_message");
    expect(users).toHaveLength(2);
    expect(users.map(entry => "content" in entry ? entry.content[0] : null)).toEqual([{ type: "text", text: "cancel" }, { type: "text", text: "follow-up" }]);
    expect(live.observed).toEqual([first, first]);
  } finally { await live.provider.close(); }
});

test("a definitely rejected steer is not presented as submitted input on interruption", async () => {
  const live = await open("steer-rejected");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await expect(live.provider.send("rejected follow-up", randomUUID(), sent.turnId!)).rejects.toThrow("Steer rejected");
    await live.provider.cancel(sent.turnId!);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(1);
  } finally { await live.provider.close(); }
});

test("large native turns retain item pagination instead of loading whole-turn payloads", async () => {
  const history = await open("large-history", true);
  try {
    const all = rows(history.entries);
    expect(all.filter(entry => entry.kind === "user_message")).toHaveLength(1);
    expect(all.filter(entry => entry.kind === "assistant_message")).toHaveLength(1);
    expect(markers(all)).toHaveLength(1);
    expect(all.at(-1)).toMatchObject({ kind: "error", code: "turn_interrupted" });
  } finally { await history.provider.close(); }
});

test.each(["reject-first", "complete-first", "reject-delayed"].flatMap(order => ["full", "notLoaded"].map(view => `${order}:${view}`)))("a racing rejected steer (%s) never persists input or a missing-input diagnosis", async scenario => {
  const live = await open(`race:${scenario}`);
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    let settled = false;
    const steer = live.provider.send("rejected racing input", randomUUID(), sent.turnId!).then(() => null, error => { settled = true; return error; });
    await live.provider.cancel(sent.turnId!);
    if (scenario.startsWith("reject-delayed")) expect(settled).toBe(false);
    expect(await steer).toMatchObject({ message: "Racing steer rejected" });
    await vi.waitFor(() => expect(markers(live.entries)).toHaveLength(1));
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(1);
    expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(false);
  } finally { await live.provider.close(); }
});

test("a racing accepted steer is retained only after its receipt settles, without delaying cancellation", async () => {
  const live = await open("race:accept-delayed:full");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    let settled = false;
    const steer = live.provider.send("accepted racing input", randomUUID(), sent.turnId!).then(receipt => { settled = true; return receipt; });
    await live.provider.cancel(sent.turnId!);
    expect(settled).toBe(false);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(1);
    expect(await steer).toMatchObject({ disposition: "queued" });
    await vi.waitFor(() => expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(2));
    const all = rows(live.entries);
    expect(all.at(-1)).toMatchObject({ code: "turn_interrupted" });
    expect(all.find(entry => entry.kind === "user_message" && entry.content.some(part => part.type === "text" && part.text === "accepted racing input"))).toBeDefined();
  } finally { await live.provider.close(); }
});

test("a timed-out racing steer retains explicitly unknown dispatch text after cancellation already settled", async () => {
  const live = await open("race:timeout:full");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    vi.useFakeTimers();
    const steer = live.provider.send("unknown racing input", randomUUID(), sent.turnId!).catch(error => error as Error);
    await live.provider.cancel(sent.turnId!);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await steer).toMatchObject({ name: "NativeRpcTimeoutError" });
    const users = rows(live.entries).filter(entry => entry.kind === "user_message");
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users[1])).toContain("dispatch outcome is unknown");
    expect(markers(live.entries)).toHaveLength(1);
  } finally { vi.useRealTimers(); await live.provider.close(); }
});

test.each(["reject-delayed", "timeout"])("close flushes an interrupted turn waiting for %s dispatch before returning", async outcome => {
  const live = await open(`race:${outcome}:notLoaded`);
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    const steer = live.provider.send("racing input", randomUUID(), sent.turnId!).catch(error => error as Error);
    await live.provider.cancel(sent.turnId!);
    await live.provider.close();
    const countAtClose = live.entries.length;
    await steer;
    await new Promise(resolve => setImmediate(resolve));
    expect(live.entries).toHaveLength(countAtClose);
    expect(markers(live.entries)).toHaveLength(1);
    const users = rows(live.entries).filter(entry => entry.kind === "user_message");
    expect(users).toHaveLength(outcome === "reject-delayed" ? 1 : 2);
    if (outcome === "timeout") expect(JSON.stringify(users[1])).toContain("dispatch outcome is unknown");
    else expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(false);
  } finally { await live.provider.close(); }
}, 3_000);

test("native process loss retains a confirmed interruption while dispatch becomes unknown", async () => {
  const live = await open("race:timeout:notLoaded");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    const steer = live.provider.send("racing input", randomUUID(), sent.turnId!).catch(error => error as Error);
    await live.provider.cancel(sent.turnId!);
    live.child.kill("SIGTERM");
    await steer;
    await live.provider.close();
    const countAtClose = live.entries.length;
    await new Promise(resolve => setImmediate(resolve));
    expect(live.entries).toHaveLength(countAtClose);
    expect(markers(live.entries)).toHaveLength(1);
    expect(rows(live.entries).filter(entry => entry.kind === "user_message")).toHaveLength(2);
  } finally { await live.provider.close(); }
}, 3_000);

test("close drains an interrupted turn's outstanding input-history projection", async () => {
  const live = await open("history-delayed");
  try {
    const sent = await live.provider.send("cancel", randomUUID(), null);
    await live.provider.cancel(sent.turnId!);
    await live.provider.close();
    const countAtClose = live.entries.length;
    await new Promise(resolve => setImmediate(resolve));
    expect(live.entries).toHaveLength(countAtClose);
    expect(markers(live.entries)).toHaveLength(1);
    expect(rows(live.entries)).toContainEqual(expect.objectContaining({ code: "native_input_missing", message: expect.stringContaining("could not be verified") }));
  } finally { await live.provider.close(); }
}, 3_000);
