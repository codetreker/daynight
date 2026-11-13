import type Database from "better-sqlite3";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readLaunchTicket, writeLaunchTicket, parseLaunchTicket, controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(async () => { for (const database of databases.splice(0)) if (database.open) database.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const database = createMemoryDatabase(); databases.push(database);
  return { home, ticket, database };
};
it.each(["codex", "claude", "copilot"] as const)("writes an immutable %s ticket and rejects launch identity reuse", async (provider) => {
  const { home, ticket: original } = await fixture();
  const ticket = { ...original, provider, configuration: { ...original.configuration, agent: provider } };
  const file = await writeLaunchTicket(home, ticket);
  expect(await readLaunchTicket(home, ticket.launchId)).toEqual(ticket);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await writeLaunchTicket(home, ticket)).toBe(file);
  await expect(writeLaunchTicket(home, { ...ticket, initialPrompt: "changed" })).rejects.toThrow(/different/);
  await expect(readLaunchTicket(home, "../escape")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toContain(ticket.initialOperationId);
});
it("rejects new native input at outbox capacity without consuming a sequence or losing events", async () => {
  const { home, ticket, database } = await fixture(); const store = openControllerLifecycleStore(path.join(home, "state.sqlite"), ticket, { database, maxOutboxBytes: 512 });
  store.appendEvent({ text: "a".repeat(400) });
  expect(() => store.appendEvent({ text: "b".repeat(400) })).toThrow(/capacity/);
  expect(() => store.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload: { text: "test" } })).toThrow(/capacity/);
  expect(store.pendingEvents()).toHaveLength(1);
  store.acknowledgeEvents("1");
  expect(store.appendEvent({ text: "next" }).sequence).toBe("2"); store.close();
});
it("keeps Unicode outbox bytes and event watermarks atomic through append and ACK failures", async () => {
  const { home, ticket, database } = await fixture();
  const store = openControllerLifecycleStore(path.join(home, "state.sqlite"), ticket, { database });
  const account = () => {
    const values = database.prepare("SELECT value FROM outbox ORDER BY sequence").all() as { value: string }[];
    const total = database.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get() as { byte_length: number };
    expect(total.byte_length).toBe(values.reduce((sum, row) => sum + Buffer.byteLength(row.value, "utf8"), 0));
    return total.byte_length;
  };
  try {
    store.appendEvent({ text: "中文 🐈\n\\\"" });
    const before = account();
    database.exec("CREATE TEMP TRIGGER fail_outbox_total BEFORE UPDATE ON outbox_totals BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END");
    expect(() => store.appendEvent({ text: "failure" })).toThrow("injected accounting failure");
    expect(store.pendingEvents()).toHaveLength(1);
    expect(account()).toBe(before);
    expect(() => store.acknowledgeEvents("1")).toThrow("injected accounting failure");
    expect(store.pendingEvents()).toHaveLength(1);
    expect(store.getLastAcknowledgedSequence()).toBe("0");
    expect(account()).toBe(before);
    database.exec("DROP TRIGGER fail_outbox_total");
    expect(store.appendEvent({ text: "二" }).sequence).toBe("2");
    store.acknowledgeEvents("1");
    const remaining = account();
    expect(remaining).toBeGreaterThan(0);
    store.acknowledgeEvents("1");
    expect(account()).toBe(remaining);
    store.acknowledgeEvents("2");
    expect(account()).toBe(0);
  } finally { store.close(); }
});
it("reports rollback when a nested outbox capacity read fails inside the original write transaction", async () => {
  const { home, ticket, database } = await fixture();
  const store = openControllerLifecycleStore(path.join(home, "state.sqlite"), ticket, { database });
  try {
    store.appendEvent({ text: "original" });
    const total = (database.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get() as { byte_length: number }).byte_length;
    database.exec("DELETE FROM outbox_totals");
    let failure: unknown;
    try { store.appendEvent({ text: "not admitted" }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: "invalid-format", context: { phase: "outbox-read" }, outcome: "rolled-back", cause: { kind: "invalid-format", outcome: "unknown" } });
    database.prepare("INSERT INTO outbox_totals VALUES(1,?)").run(total);
    expect(store.pendingEvents()).toHaveLength(1);
    expect(store.appendEvent({ text: "next" }).sequence).toBe("2");
  } finally { store.close(); }
});
it("fences later outbox writes and watermarks while keeping reads and shutdown available", async () => {
  const { home, ticket, database } = await fixture();
  const store = openControllerLifecycleStore(path.join(home, "state.sqlite"), ticket, { database, contentOwnedLocally: true, maxOutboxBytes: 512 });
  const entryId = randomUUID();
  try {
    store.appendEvent({ text: "original" });
    store.markProjectionGap("retained");
    const before = store.pendingEvents(), source = store.getHistorySource(), floor = store.getSourceFloor();
    const total = database.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get();
    let resume!: () => void;
    const callback = (async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      return store.projectTimeline({ entryId, revision: "1", kind: "reasoning", text: "later" });
    })();
    store.disableOutboxWrites();
    store.disableOutboxWrites();
    resume();
    await expect(callback).rejects.toThrow("outbox writes are disabled");
    expect(() => store.appendEvent({ text: "later" })).toThrow("outbox writes are disabled");
    expect(() => store.appendEvent({ text: "x".repeat(600) })).toThrow("outbox writes are disabled");
    expect(() => store.acknowledgeEvents("1")).toThrow("outbox writes are disabled");
    expect(() => store.drainProjectionGap()).toThrow("outbox writes are disabled");
    expect(store.hasTimelineEntry(entryId)).toBe(false);
    expect(store.pendingEvents()).toEqual(before);
    expect(store.getHistorySource()).toEqual(source);
    expect(store.getSourceFloor()).toBe(floor);
    expect(database.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get()).toEqual(total);
  } finally { store.close(); }
});

it("fences a write disabled while serializing an oversized event", async () => {
  const { home, ticket, database } = await fixture();
  const store = openControllerLifecycleStore(path.join(home, "state.sqlite"), ticket, { database, contentOwnedLocally: true, maxOutboxBytes: 512 });
  try {
    store.appendEvent({ text: "original" });
    const before = store.pendingEvents(), source = store.getHistorySource(), floor = store.getSourceFloor();
    expect(() => store.appendEvent({ toJSON: () => { store.disableOutboxWrites(); return { text: "x".repeat(600) }; } })).toThrow("outbox writes are disabled");
    expect(store.pendingEvents()).toEqual(before);
    expect(store.getHistorySource()).toEqual(source);
    expect(store.getSourceFloor()).toBe(floor);
  } finally { store.close(); }
});
it("replays numeric event order across decimal digit boundaries", async () => {
  const { home, ticket, database } = await fixture(); const store = openControllerLifecycleStore(path.join(home,"state.sqlite"),ticket,{database});
  for(let i=1;i<=110;i++) store.appendEvent({index:i});
  store.acknowledgeEvents("8");
  expect(store.pendingEvents(100).map(event=>event.sequence)).toEqual(Array.from({length:100},(_,i)=>String(i+9)));
  store.close();
});

it("deduplicates equivalent operation JSON regardless of object key insertion order",async()=>{
 const {home,ticket,database}=await fixture();const store=openControllerLifecycleStore(path.join(home,"state.sqlite"),ticket,{database});const operationId=randomUUID();
 const first=store.prepareOperation({operationId,kind:"send_message",payload:{text:"hello",expectedTurnId:null}});
 expect(store.prepareOperation({operationId,kind:"send_message",payload:{expectedTurnId:null,text:"hello"}})).toEqual(first);store.close();
});

it("test tickets and journals omit task identity and preserve no-input initialization", async () => {
  const { home, ticket: task, database } = await fixture();
  const { claimId: _, projectId: __, taskId: ___, workerId: ____, worktreeId: _____, userId: ______, ...common } = task;
  const ticket: ControllerLaunchTicket = { ...common, testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "none", initialPrompt: "" };
  await writeLaunchTicket(home, ticket);
  expect(await readLaunchTicket(home, ticket.launchId)).toEqual(ticket);
  const store = openControllerLifecycleStore(path.join(home, "test.sqlite"), ticket, { database });
  try {
    expect(store.getSnapshot()).toMatchObject({ testExecutionId: ticket.testExecutionId, initialInputState: "not_required" });
    expect(store.getSnapshot()).not.toHaveProperty("claimId");
    expect(() => store.patchSnapshot({ testExecutionId: randomUUID() } as never)).toThrow("identity");
  } finally { store.close(); }
  const resumed = { ...ticket, launchId: randomUUID(), resumeNativeSessionId: randomUUID() };
  await writeLaunchTicket(home, resumed);
  expect(await readLaunchTicket(home, resumed.launchId)).toEqual(resumed);
  await expect(writeLaunchTicket(home, { ...resumed, launchId: randomUUID(), initialInput: "prompt", initialPrompt: "replay" })).rejects.toThrow("resume binding");
  await expect(writeLaunchTicket(home, { ...ticket, claimId: randomUUID() } as never)).rejects.toThrow();
});

it("compacts offline transport without losing local history or blocking native input", async () => {
  const { home, ticket, database } = await fixture(); const store = openControllerLifecycleStore(path.join(home, "content.sqlite"), ticket, { database, contentOwnedLocally: true, maxOutboxBytes: 512 });
  try {
    for (let i = 0; i < 20; i++) store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "x".repeat(200) });
    expect(store.readTimeline({ historyEpoch: randomUUID(), direction: "tail", cursor: null, limit: 100 }).items).toHaveLength(20);
    expect(BigInt(store.getSourceFloor())).toBeGreaterThan(0n);
    expect(store.pendingEvents()).toHaveLength(1);
    expect(store.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload: { text: "continue" } }).state).toBe("accepted");
  } finally { store.close(); }
});

it("serves only registered local resources in verified bounded chunks", async () => {
  const { home, ticket, database } = await fixture(); const store = openControllerLifecycleStore(path.join(home, "content.sqlite"), ticket, { database, contentOwnedLocally: true });
  const bytes = Buffer.from("private local resource");
  const resource = { resourceId: randomUUID(), name: "output.txt", status: "available" as const, mediaType: "text/plain", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  try {
    expect(() => store.saveResource(resource, Buffer.from("wrong"))).toThrow(/descriptor/);
    store.saveResource(resource, bytes);
    expect(store.readResource(resource.resourceId, "0", 7)).toMatchObject({ offset: "0", data: bytes.subarray(0, 7).toString("base64"), eof: false });
    expect(store.readResource(resource.resourceId, "7", 524288)).toMatchObject({ data: bytes.subarray(7).toString("base64"), eof: true });
    expect(() => store.readResource("../../private", "0", 1)).toThrow(/unavailable/);
    expect(() => store.readResource(resource.resourceId, "999", 1)).toThrow(/unavailable/);
    expect(() => store.readResource(resource.resourceId, "0", 524289)).toThrow(/limit/);
    expect(() => store.saveResource({ ...resource, name: "other" }, bytes)).toThrow(/identity/);
  } finally { store.close(); }
});

it.each(["<", "\u2028", "x"])("keeps %s tool content local and uses identical bounded live/history display", async (character) => {
  const { home, ticket, database } = await fixture();
  const filename = path.join(home, "display.sqlite");
  const store = openControllerLifecycleStore(filename, ticket, { database, contentOwnedLocally: true });
  const text = character.repeat(character === "x" ? 1_048_576 : 200_000);
  const entry = { entryId: randomUUID(), revision: "1", kind: "tool_call" as const, callId: "call", name: "shell", input: text, output: [{ type: "text" as const, text }], status: "completed" as const, truncated: false };
  if (character === "x") expect(Buffer.byteLength(JSON.stringify(entry))).toBeGreaterThan(2 * 1024 * 1024);
  try {
    const emitted = store.projectTimeline(entry)!;
    const page = store.readTimeline({ historyEpoch: randomUUID(), direction: "tail", cursor: null, limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(emitted.payload).toEqual({ kind: "timeline_upsert", payload: page.items[0] });
    if (character === "<") expect(page.items[0]).toMatchObject({ kind: "tool_call", input: text, output: entry.output });
    else expect(page.items[0]).toMatchObject({ entryId: entry.entryId, entrySeq: "1", revision: "1", kind: "error", code: "display_budget_exceeded" });
    store.acknowledgeEvents(emitted.sequence);
    expect(store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "following event" })).toMatchObject({ sequence: "2" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('projection','resources')").all()).toEqual([]);
    const { openTimelineStore } = await import("../../../src/commands/controller/content/timeline-store.js");
    const timeline = openTimelineStore(database, { assertWrite: () => { throw new Error("Read-only assertion cannot publish history."); } });
    expect(timeline.get(entry.entryId)).toMatchObject({ input: text, output: entry.output });
  } finally { store.close(); }
});

it.each([
  ["null", null], ["undefined", undefined], ["number", 7], ["object", {}], ["array", []],
  ["empty", ""], ["blank", " \n\t"], ["unpaired high surrogate", "\ud800"], ["unpaired low surrogate", "\udc00"],
  ["ASCII overflow", "a".repeat(65_537)], ["UTF-8 overflow", "😀".repeat(16_384) + "a"],
])("rejects %s role instructions", async (_label, instructions) => {
  const { home, ticket, database } = await fixture();
  const invalid = { ...ticket, instructions };
  expect(() => parseLaunchTicket(invalid)).toThrow(/instructions/i);
  await expect(writeLaunchTicket(home, invalid as ControllerLaunchTicket)).rejects.toThrow(/instructions/i);
});

it("persists exact role bytes at the UTF-8 limit and binds them to the immutable launch", async () => {
  const { home, ticket: original } = await fixture();
  const instructions = " \n角色 e\u0301 😀\n" + "a".repeat(65_536 - Buffer.byteLength(" \n角色 e\u0301 😀\n"));
  const ticket = { ...original, instructions };
  expect(Buffer.byteLength(instructions)).toBe(65_536);
  await writeLaunchTicket(home, ticket);
  expect((await readLaunchTicket(home, ticket.launchId)).instructions).toBe(instructions);
  expect(controllerPayloadHash(ticket)).not.toBe(controllerPayloadHash(original));
  expect(controllerPayloadHash({ ...ticket, instructions: "another role" })).not.toBe(controllerPayloadHash(ticket));
  await expect(writeLaunchTicket(home, { ...ticket, instructions: "another role" })).rejects.toThrow(/different ticket/);
  await expect(writeLaunchTicket(home, original)).rejects.toThrow(/different ticket/);
  expect(() => parseLaunchTicket({ ...ticket, unexpected: true })).toThrow(/invalid fields/);
  const { cwd: _cwd, ...missingRequired } = ticket;
  expect(() => parseLaunchTicket({ ...missingRequired, unexpected: home })).toThrow(/invalid fields/);
});

it("keeps a previously readable maximum-size prompt readable after adding a role", async () => {
  const { home, ticket, database } = await fixture();
  const initialPrompt = '\"'.repeat(1_000_000) + "a".repeat(3_194_304);
  expect(Buffer.byteLength(initialPrompt)).toBe(4 * 1024 * 1024);
  const legacy = { ...ticket, initialPrompt };
  await writeLaunchTicket(home, legacy);
  expect(await readLaunchTicket(home, legacy.launchId)).toEqual(legacy);
  const withRole = { ...legacy, launchId: randomUUID(), instructions: "r".repeat(65_536) };
  await writeLaunchTicket(home, withRole);
  expect(await readLaunchTicket(home, withRole.launchId)).toEqual(withRole);
});

it("uses the same serialized byte boundary for ticket writes and reads", async () => {
  const { home, ticket, database } = await fixture();
  const maximum = 6 * 1024 * 1024;
  const withRole = { ...ticket, initialPrompt: "a".repeat(4 * 1024 * 1024), instructions: "\u0000".repeat(65_536) };
  const extraEscapes = maximum - Buffer.byteLength(JSON.stringify(withRole) + "\n");
  const exact = { ...withRole, initialPrompt: '\"'.repeat(extraEscapes) + "a".repeat(withRole.initialPrompt.length - extraEscapes) };
  expect(Buffer.byteLength(JSON.stringify(exact) + "\n")).toBe(maximum);
  const file = await writeLaunchTicket(home, exact);
  expect((await stat(file)).size).toBe(maximum);
  expect(await readLaunchTicket(home, exact.launchId)).toEqual(exact);
  const tooLarge = { ...exact, launchId: randomUUID(), initialPrompt: '\"' + exact.initialPrompt.slice(0, -1) };
  expect(Buffer.byteLength(JSON.stringify(tooLarge) + "\n")).toBe(maximum + 1);
  await expect(writeLaunchTicket(home, tooLarge)).rejects.toThrow(/serialized.*6 MiB/i);
  expect(await readLaunchTicket(home, exact.launchId)).toEqual(exact);
  await writeFile(file, JSON.stringify({ ...tooLarge, launchId: exact.launchId }) + "\n");
  await expect(readLaunchTicket(home, exact.launchId)).rejects.toThrow(/private regular file/);
});


it("binds provenance to dispatched operations without converting unknown delivery into success", async () => {
  const { home, ticket, database } = await fixture();
  const store = openControllerLifecycleStore(path.join(home, "origins.sqlite"), ticket, { database, contentOwnedLocally: true });
  const operationId = randomUUID(), entryId = randomUUID(), nativeSessionId = "native-source";
  const payload = { content: [{ type: "text", text: "same input" }], expectedTurnId: null };
  try {
    store.patchSnapshot({ nativeSessionId });
    const user = store.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload });
    expect(store.prepareOperation({ operationId: user.operationId, kind: "send_message", payload: { ...payload, origin: "user" } })).toEqual(user);
    expect(() => store.prepareOperation({ operationId: user.operationId, kind: "send_message", payload: { ...payload, origin: "daynight" } })).toThrow(/different content/);
    store.prepareOperation({ operationId, kind: "send_message", payload: { ...payload, origin: "daynight" } });
    expect(() => store.associateInputMessage(operationId, nativeSessionId, entryId)).toThrow(/dispatched/);
    store.markDispatching(operationId); store.recordOperation(operationId, "unknown");
    store.associateInputMessage(operationId, nativeSessionId, entryId);
    store.projectTimeline({ entryId, kind: "user_message", revision: "1", content: [{ type: "text", text: "retained input" }] });
    expect(store.getTimelineEntry(entryId)).toMatchObject({ origin: "daynight" });
    expect(store.getOperation(operationId)?.state).toBe("unknown");
    expect(() => store.projectTimeline({ entryId, kind: "user_message", origin: "user", revision: "1", content: [] })).toThrow(/origin/);
    const conflictingOperation = randomUUID();
    store.prepareOperation({ operationId: conflictingOperation, kind: "send_message", payload: { ...payload, origin: "daynight" } });
    store.markDispatching(conflictingOperation);
    expect(() => store.associateInputMessage(conflictingOperation, nativeSessionId, entryId)).toThrow(/conflicts/);
  } finally { store.close(); }
});
