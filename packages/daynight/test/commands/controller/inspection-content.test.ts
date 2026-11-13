import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { SourceTimelineEntry } from "../../../src/session/controller-protocol.js";
import { parseInspectionPage } from "../../../src/session/history.js";
import { createWatchdogSource, type WatchdogApiScope } from "../../../src/commands/worker/bots/apps/watchdog-transport.js";
import { createWatchdogEvaluator, type WatchdogObservation, type WatchdogState } from "../../../src/commands/worker/bots/apps/watchdog.js";
import type { AssistantTask, AssistantTaskClient, AssistantTaskItem, JsonValue } from "../../../src/api/assistant-task.js";
import type { AssistantApplicationContext } from "../../../src/commands/worker/bots/assistant-tasks.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "inspection-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const file = path.join(home, "journal.sqlite");
  return { file, ticket, open: () => openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true }) };
};
const query = (historyEpoch: string, cursor: string | null = null, limit = 20) => ({ historyEpoch, cursor, limit, responseOverhead: 4096 });
const responseBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));

it("reads durable original entries backwards without repeating concurrent appends", async () => {
  const f = await fixture(); let store = f.open();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  try {
    ids.forEach((entryId, i) => store.projectTimeline({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text: `message ${i}` }] }));
    store.acknowledgeEvents("5"); store.close(); store = f.open();
    const epoch = randomUUID(), tail = store.readInspection(query(epoch, null, 2));
    expect(tail.items.map(item => item.entryId)).toEqual(ids.slice(3));
    expect(tail.items[0]).toMatchObject({ role: "assistant", timestamp: null, body: { content: [{ type: "text", text: "message 3" }] }, truncated: false, contentRef: null });
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "later" });
    const middle = store.readInspection(query(epoch, tail.beforeCursor, 2));
    const first = store.readInspection(query(epoch, middle.beforeCursor, 2));
    expect([...first.items, ...middle.items, ...tail.items].map(item => item.entryId)).toEqual(ids);
    expect(first.hasMoreBefore).toBe(false);
    expect(() => store.readInspection(query(randomUUID(), tail.beforeCursor))).toThrow(expect.objectContaining({ code: "reset_required" }));
  } finally { store.close(); }
});

it("returns a real empty page and validates limits before reading", async () => {
  const f = await fixture(), store = f.open();
  try {
    const epoch = randomUUID();
    expect(store.readInspection(query(epoch))).toMatchObject({ items: [], beforeCursor: null, hasMoreBefore: false, coverage: { state: "complete", reason: null } });
    for (const limit of [0, 201, 1.5]) expect(() => store.readInspection(query(epoch, null, limit))).toThrow();
    expect(() => store.readInspection({ ...query(epoch), responseOverhead: 262144 })).toThrow();
  } finally { store.close(); }
});

it("supplies stable untimed input evidence to Watchdog through the real inspection producer", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), inputId = randomUUID();
  try {
    store.projectTimeline({ entryId: inputId, revision: "1", kind: "user_message", content: [{ type: "text", text: "Complete the assigned task." }], origin: "daynight" });
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "Please continue" }] });
    const source = createWatchdogSource(f.ticket.userId, (async (_signal, action) => action({
      readTaskSession: async () => ({ ...store.readInspection(query(epoch)), source: "live", sessionId: f.ticket.sessionId }),
    } as never)) as WatchdogApiScope);
    const observation = { projectId: f.ticket.projectId, taskId: f.ticket.taskId, session: { sessionId: f.ticket.sessionId } } as WatchdogObservation;
    const history = await source.history(observation, new AbortController().signal);
    expect(history).toMatchObject({ complete: true, lastInputAt: null, untimedInputId: `${epoch}/${inputId}/1`, lastAssistantText: "Please continue" });
    expect(history.inputQuietSince).toBeUndefined();
  } finally { store.close(); }
});

it("keeps escalation active when a large automatic input is projected without its origin", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), assistantId = randomUUID(), inputId = randomUUID();
  let now = Date.parse("2026-11-14T00:00:00Z");
  try {
    store.projectTimeline({ entryId: assistantId, revision: "1", kind: "assistant_message", content: [{ type: "text", text: "Please continue" }] });
    store.projectTimeline({ entryId: inputId, revision: "1", kind: "user_message", origin: "daynight", content: [{ type: "text", text: "x".repeat(300 * 1024) }] });
    const projected = store.readInspection(query(epoch));
    expect(projected.coverage.state).toBe("complete");
    expect(projected.items.at(-1)).toMatchObject({ entryId: inputId, body: null, truncated: true });
    const observation = { projectId: f.ticket.projectId, taskId: f.ticket.taskId, title: "Task", inScope: true,
      session: { sessionId: f.ticket.sessionId, observation: "observed", error: null, freshUntil: null, registration: "registered", lifecycle: "active", activity: "idle", indicator: "warning", reason: "idle", send: { allowed: true } },
    } as WatchdogObservation;
    const source = createWatchdogSource(f.ticket.userId, (async (_signal, action) => action({
      readTaskSession: async () => ({ ...store.readInspection(query(epoch)), source: "live", sessionId: f.ticket.sessionId }),
    } as never)) as WatchdogApiScope);
    const history = await source.history(observation, new AbortController().signal);
    expect(history).toMatchObject({ complete: true, lastEntryId: `${epoch}/${assistantId}/1`, untimedInputId: `${epoch}/${inputId}/1`, lastInputAt: null });
    const state: WatchdogState = { schemaVersion: 1, since: now - 600_000, reportedCategory: "stalled", reportedAt: now,
      closedAt: null, recurrence: false, observation, notices: [], attempt: { operationId: randomUUID(), ruleId: "continue", message: "Continue", at: now, followUpSince: now,
        historyId: `${epoch}/${assistantId}/1`, observation, result: "confirmed", notifiedResult: "confirmed", escalated: false, progressed: false } };
    let item = { id: randomUUID(), key: observation.taskId, taskId: randomUUID(), episode: "1", state: "open", category: "stalled", version: "1", appState: state as unknown as JsonValue } as AssistantTaskItem;
    const events: { type: string }[] = [], records: unknown[] = [];
    const api = {
      listItems: async () => ({ items: [structuredClone(item)], nextCursor: null }),
      saveItem: async (_task: string, value: Partial<AssistantTaskItem>) => { item = { ...item, ...value }; return structuredClone(item); },
      listRecords: async () => ({ items: records, nextCursor: null }),
      addRecord: async (_task: string, value: unknown) => { records.push(value); return value; },
      listEvents: async () => ({ items: events, nextCursor: null }),
      addEvent: async (_task: string, value: { type: string }) => { events.push(value); return value; },
    } as unknown as AssistantTaskClient;
    const task = { id: item.taskId } as AssistantTask;
    const context: AssistantApplicationContext = { task, botId: randomUUID(), signal: new AbortController().signal,
      withClaim: action => action(api, task, { claimToken: "fixture", claimGeneration: "1" }) };
    const evaluator = createWatchdogEvaluator(context, { ...source, scan: async () => [observation] }, { clock: { now: () => now, wait: async () => undefined } });
    now += 599_999; await evaluator.tick(); expect(events).toEqual([]);
    now += 1; await evaluator.tick(); await evaluator.tick();
    expect((item.appState as unknown as WatchdogState).attempt).toMatchObject({ progressed: false, escalated: true });
    expect(events.map(event => event.type)).toEqual(["escalation"]);
  } finally { store.close(); }
});

it("reassembles canonical original JSON with Unicode-safe chunks beyond the web display budget", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), entryId = randomUUID();
  const text = "\u2028😀".repeat(140000) + "<>&\n";
  try {
    store.projectTimeline({ entryId, revision: "1", kind: "tool_call", callId: "tool", name: "shell", input: text, output: [{ type: "text", text: "工具输出" }], status: "completed", truncated: false });
    expect(store.readTimeline({ historyEpoch: epoch, direction: "tail", cursor: null, limit: 1 }).items[0]).toMatchObject({ kind: "error", code: "display_budget_exceeded" });
    const page = store.readInspection(query(epoch, null, 1)), item = page.items[0]!;
    expect(page.coverage).toEqual({ state: "complete", reason: null });
    expect(item).toMatchObject({ entryId, kind: "tool_call", body: null, truncated: true });
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    let cursor = item.contentRef!.cursor, original = "", offset = 0;
    for (;;) {
      const chunk = store.readEntryChunk({ historyEpoch: epoch, cursor, limit: 32768 });
      expect(chunk.offset).toBe(String(offset));
      expect(chunk.fragment.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(chunk.fragment)).toBeLessThanOrEqual(32768);
      expect(responseBytes(chunk) + 4096).toBeLessThanOrEqual(262144);
      original += chunk.fragment; offset += Buffer.byteLength(chunk.fragment);
      if (chunk.eof) { expect(chunk.nextCursor).toBeNull(); break; }
      expect(chunk.nextCursor).not.toBe(cursor); cursor = chunk.nextCursor!;
    }
    expect(String(Buffer.byteLength(original))).toBe(item.contentRef!.byteLength);
    expect(createHash("sha256").update(original).digest("hex")).toBe(item.contentRef!.sha256);
    expect(JSON.parse(original)).toMatchObject({ entryId, entrySeq: "1", revision: "1", input: text, output: [{ type: "text", text: "工具输出" }] });
    expect(original.indexOf('"callId"')).toBeLessThan(original.indexOf('"entryId"'));
    store.projectTimeline({ entryId, revision: "1", kind: "reasoning", text: "updated" });
    expect(() => store.readEntryChunk({ historyEpoch: epoch, cursor: item.contentRef!.cursor, limit: 32768 })).toThrow(expect.objectContaining({ code: "content_changed" }));
    expect(() => store.readEntryChunk({ historyEpoch: randomUUID(), cursor, limit: 32768 })).toThrow(expect.objectContaining({ code: "reset_required" }));
  } finally { store.close(); }
});

it.each([32, 270000])("retains source truncation coverage before fitting a %i-byte tool input", async size => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), entryId = randomUUID(), resourceId = randomUUID();
  try {
    store.saveResource({ resourceId, status: "unavailable", name: "missing.txt", mediaType: null, byteLength: null, sha256: null, error: null });
    store.projectTimeline({ entryId, revision: "1", kind: "tool_call", callId: "tool", name: "shell", input: "x".repeat(size), output: [{ type: "resource", resourceId, label: "Output" }], status: "completed", truncated: true });
    const page = store.readInspection(query(epoch, null, 1));
    expect(page.coverage).toEqual({ state: "partial", reason: "entry_truncated" });
    expect(page.items[0]).toMatchObject({ entryId, truncated: size > 262144 });
    expect(page.items[0]!.body === null).toBe(size > 262144);
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    const newest = randomUUID();
    store.projectTimeline({ entryId: newest, revision: "1", kind: "reasoning", text: "A complete newer entry" });
    const tail = store.readInspection(query(epoch, null, 1));
    expect(tail.items.map(item => item.entryId)).toEqual([newest]);
    expect(tail.coverage).toEqual({ state: "partial", reason: "entry_truncated" });
    expect(store.readInspection(query(epoch, page.beforeCursor, 1))).toMatchObject({ items: [], coverage: { state: "partial", reason: "entry_truncated" } });
  } finally { store.close(); }
});

it.each(["missing", "pending", "failed", "unavailable", "available"] as const)("reports global %s referenced resource coverage outside the selected page", async status => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), resourceId = randomUUID();
  try {
    const bytes = Buffer.from("Available resource");
    if (status !== "missing") store.saveResource({ resourceId, status, name: "output.txt", mediaType: status === "available" ? "text/plain" : null, byteLength: status === "available" ? String(bytes.length) : null, sha256: status === "available" ? createHash("sha256").update(bytes).digest("hex") : null, error: null }, status === "available" ? bytes : undefined);
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "resource", resourceId, label: "Output" }] });
    const newest = randomUUID();
    store.projectTimeline({ entryId: newest, revision: "1", kind: "reasoning", text: "A complete newer entry" });
    const page = store.readInspection(query(epoch, null, 1));
    expect(page.items.map(item => item.entryId)).toEqual([newest]);
    expect(page.coverage).toEqual(status === "available" ? { state: "complete", reason: null } : { state: "partial", reason: "resource_unavailable" });
  } finally { store.close(); }
});

it("keeps known unreferenced unavailable resources in global coverage", async () => {
  const f = await fixture(), store = f.open();
  try {
    store.saveResource({ resourceId: randomUUID(), status: "failed", name: "failed.txt", mediaType: null, byteLength: null, sha256: null, error: null });
    expect(store.readInspection(query(randomUUID()))).toMatchObject({ items: [], coverage: { state: "partial", reason: "resource_unavailable" } });
  } finally { store.close(); }
});

it("advances past entries replaced with content references within the full response budget", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID();
  try {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    ids.forEach(entryId => store.projectTimeline({ entryId, revision: "1", kind: "reasoning", text: "\u2028".repeat(30000) }));
    const page = store.readInspection(query(epoch, null, 4));
    expect(page.items.map(item => item.entryId)).toEqual(ids);
    expect(page.items.some(item => item.body === null && item.contentRef !== null)).toBe(true);
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    expect(page.hasMoreBefore).toBe(false);
    expect(store.readInspection(query(epoch, page.beforeCursor, 4)).items).toEqual([]);
  } finally { store.close(); }
});

it("keeps valid fractional form bounds in canonical entry content", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), entryId = randomUUID();
  try {
    store.projectTimeline({ entryId, revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", kind: "form", state: "pending", title: "x".repeat(270000), canDismiss: false, fields: [{ fieldId: "fraction", type: "number", label: "Fraction", required: true, min: 0.1, max: 1e21 }, { fieldId: "tiny", type: "number", label: "Tiny", required: false, min: -0, max: 1e-7 }] } });
    const item = store.readInspection(query(epoch, null, 1)).items[0]!;
    let cursor = item.contentRef!.cursor, original = "";
    for (;;) {
      const chunk = store.readEntryChunk({ historyEpoch: epoch, cursor, limit: 32768 }); original += chunk.fragment;
      if (chunk.eof) break;
      cursor = chunk.nextCursor!;
    }
    expect(original).toContain('"max":1e+21,"min":0.1');
    expect(original).toContain('"max":1e-7,"min":0');
    expect(createHash("sha256").update(original).digest("hex")).toBe(item.contentRef!.sha256);
  } finally { store.close(); }
});

it("reserves HTML escaping used by the final MCP response encoder", async () => {
  const f = await fixture(), store = f.open(), epoch = randomUUID();
  try {
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "<>&".repeat(20000) });
    const page = store.readInspection(query(epoch, null, 1));
    expect(responseBytes(page) + 4096).toBeLessThanOrEqual(262144);
    expect(page.items[0]).toMatchObject({ body: null, truncated: true });
  } finally { store.close(); }
});

it.each(["image", "markdown", "reasoning", "retained", "tool"] as const)("includes %s image references in descriptor previews and global coverage", async location => {
  const f = await fixture(), store = f.open(), epoch = randomUUID(), resourceId = randomUUID(), imageId = randomUUID();
  const bytes = Buffer.from("Saved image"), name = "图".repeat(341) + "x";
  const image = { type: "image" as const, imageId, resourceId, label: "original" };
  const binding = { imageId, start: 0, end: 1, part: image };
  const metadata = { partId: randomUUID(), revision: "1", textSha256: createHash("sha256").update("x").digest("hex"), complete: true, truncated: false, bindings: location === "retained" ? [] : [binding], retainedImages: location === "retained" ? [{ ...binding, sourceRevision: "1", sourceTextSha256: "a".repeat(64), linkHref: null }] : [] };
  const base = { entryId: randomUUID(), revision: "1", imageProjectionError: null };
  const markdown = { type: "markdown" as const, text: "x", ...metadata };
  const entry: SourceTimelineEntry = location === "reasoning" || location === "retained" ? { ...base, kind: "reasoning", text: "x", markdown: metadata }
    : location === "tool" ? { ...base, kind: "tool_call", callId: "tool", name: "shell", input: "x", output: [markdown], status: "completed", truncated: false }
    : { ...base, kind: "assistant_message", content: [location === "image" ? image : markdown] };
  try {
    store.projectTimeline(entry);
    const missing = store.readInspection(query(epoch));
    expect(missing.items[0]!.resources).toEqual([{ resourceId, status: "unavailable", name: resourceId, mediaType: null, byteLength: null, sha256: null }]);
    expect(missing.coverage).toEqual({ state: "partial", reason: "resource_unavailable" });
    store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", text: "newer" });
    expect(store.readInspection(query(epoch, null, 1)).coverage).toEqual({ state: "partial", reason: "resource_unavailable" });
    store.saveResource({ resourceId, status: "available", name, mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null, revision: "1", width: 1, height: 1, frameCount: 1 }, bytes);
    const page = store.readInspection(query(epoch));
    expect(page.items[0]!.resources).toEqual([{ resourceId, status: "available", name, mediaType: "image/png", byteLength: "11", sha256: createHash("sha256").update(bytes).digest("hex") }]);
    expect(parseInspectionPage(page)).toEqual(page);
    expect(page.coverage).toEqual({ state: "complete", reason: null });
    expect(store.readInspection(query(epoch, null, 1)).coverage).toEqual({ state: "complete", reason: null });
  } finally { store.close(); }
});

it.each(["unavailable", "projection"] as const)("retains %s image coverage outside the selected page", async gap => {
  const f = await fixture(), store = f.open(), epoch = randomUUID();
  const error = { code: "source_unavailable", message: "Projection is unavailable." };
  try {
    if (gap === "unavailable") store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "image_unavailable", imageId: randomUUID(), label: "missing", error }] });
    else store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "reasoning", imageProjectionError: error, text: "x", markdown: { partId: randomUUID(), revision: "1", textSha256: createHash("sha256").update("x").digest("hex"), complete: true, truncated: false, bindings: null, retainedImages: [] } });
    const newest = randomUUID();
    store.projectTimeline({ entryId: newest, revision: "1", kind: "reasoning", text: "newer" });
    const page = store.readInspection(query(epoch, null, 1));
    expect(page.items.map(item => item.entryId)).toEqual([newest]);
    expect(page.coverage).toEqual({ state: "partial", reason: "resource_unavailable" });
  } finally { store.close(); }
});
