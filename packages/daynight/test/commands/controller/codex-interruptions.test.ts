import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { fileURLToPath } from "node:url";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";

const open = async (scenario: string, resumed = false, journal?: { hasTimelineEntry(id: string): boolean; projectTimeline(entry: ProviderEntry): unknown }) => {
  const entries: ProviderEntry[] = [], observed: string[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: resumed ? "native-thread" : null,
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), env: { ...process.env, CODEX_TEST_INTERRUPT: scenario },
    ...(journal ? { hasTimelineEntry: (id: string) => journal.hasTimelineEntry(id) } : {}),
    onTimeline: entry => { entries.push(entry); journal?.projectTimeline(entry); }, onInputObserved: id => observed.push(id), onState: () => {}, onSpawn: () => {} });
  return { provider, entries, observed };
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


test.each(["history-user", "history-read-failure", "ack-first"])("%s input keeps one durable row across a new provider and journal instance", async scenario => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "codex-interrupt-"));
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "test", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const filename = path.join(home, "state.sqlite"), historyEpoch = randomUUID();
  let journal = openControllerLifecycleStore(filename, ticket, { contentOwnedLocally: true });
  const stored = () => journal.readTimeline({ historyEpoch, direction: "tail", cursor: null, limit: 100 }).items;
  const hooks = { hasTimelineEntry: (id: string) => journal.hasTimelineEntry(id), projectTimeline: (entry: ProviderEntry) => journal.projectTimeline(entry) };
  try {
    const live = await open(scenario, false, hooks);
    try {
      const sent = await live.provider.send("cancel", "11111111-1111-4111-8111-111111111111", null);
      await live.provider.cancel(sent.turnId!);
      if (scenario === "history-user") await vi.waitFor(() => expect(live.observed).toContain("11111111-1111-4111-8111-111111111111"));
      if (scenario === "history-read-failure") await vi.waitFor(() => expect(live.entries.some(entry => entry.kind === "error" && entry.code === "native_input_missing")).toBe(true));
    } finally { await live.provider.close(); }
    const originalUser = stored().find(entry => entry.kind === "user_message")!;
    journal.close(); journal = openControllerLifecycleStore(filename, ticket, { contentOwnedLocally: true });
    const restored = await open("history-user", true, hooks);
    await restored.provider.close();
    const users = stored().filter(entry => entry.kind === "user_message");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ entryId: originalUser.entryId, entrySeq: originalUser.entrySeq, content: [{ type: "text", text: "cancel" }] });
    expect(markers(stored())).toHaveLength(1);
  } finally { journal.close(); await rm(home, { recursive: true, force: true }); }
});
