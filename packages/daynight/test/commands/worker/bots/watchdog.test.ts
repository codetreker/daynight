import { describe, expect, it, vi } from "vitest";
import { createAssistantTaskClient } from "../../../../src/api/assistant-task.js";
import { createOperation } from "../../../../src/api/operation.js";
import type { AssistantTask, AssistantTaskClient, AssistantTaskEvent, AssistantTaskItem, AssistantTaskRecord, JsonValue } from "../../../../src/api/assistant-task.js";
import type { TaskSessionObservation } from "../../../../src/api/task-observation.js";
import type { AssistantApplicationContext } from "../../../../src/commands/worker/bots/assistant-tasks.js";
import { classifyWatchdogObservation, createWatchdogEvaluator, WATCHDOG_DURATION, type WatchdogCategory, type WatchdogHistory, type WatchdogObservation, type WatchdogSource, type WatchdogState } from "../../../../src/commands/worker/bots/apps/watchdog.js";
import { createWatchdogSource, type WatchdogApiScope } from "../../../../src/commands/worker/bots/apps/watchdog-transport.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const start = Date.parse("2026-11-13T00:00:00Z");
const session = (): TaskSessionObservation => ({ schemaVersion: 1, observation: "observed", registration: "registered", sessionId: id(3), nativeSessionId: id(4), claimId: id(5), executionGeneration: "1", connectionEpoch: "1", agentControlMode: "web", contentKind: "native_timeline", provider: "codex", indicator: "warning", reason: "idle", activity: "idle", connectionState: "connected", lifecycle: "active", currentTurnId: null, needsAttention: false, send: { allowed: true, mode: "start", reason: "allowed" }, observedAt: new Date(start).toISOString(), lastSeenAt: new Date(start).toISOString(), freshUntil: new Date(start + 30_000).toISOString(), error: null });
const rule: JsonValue = [{ id: "continue", category: "stalled", match: { contains: "continue" }, action: { kind: "send_message", message: "Continue the assigned task." } }];

const fixture = () => {
  let now = start, allowed = true, sendResult = "confirmed", operationResult = "unknown", failSaveAfterSend = false;
  let rules: JsonValue = [];
  const observation: WatchdogObservation = { projectId: id(1), taskId: id(2), title: "Task", inScope: true, session: session() };
  const history: WatchdogHistory = { complete: true, lastEntryId: "entry-1", lastProgressId: "entry-1", lastAssistantText: "Please continue", lastInputAt: start - 300_000 };
  const items = new Map<string, AssistantTaskItem>(), events: AssistantTaskEvent[] = [], records: AssistantTaskRecord[] = [];
  const page = <T>(all: T[], query: { cursor?: string } = {}) => { const index = Number(query.cursor ?? 0); return { items: all.slice(index, index + 1), nextCursor: index + 1 < all.length ? String(index + 1) : null, observedAt: new Date(now).toISOString() }; };
  const api = {
    listItems: vi.fn(async (_task: string, query: { cursor?: string }) => page([...items.values()].map(item => structuredClone(item)), query)),
    saveItem: vi.fn(async (taskId, input, itemId) => {
      if (failSaveAfterSend && source.send.mock.calls.length) { failSaveAfterSend = false; throw new Error("lost item response"); }
      const current = itemId === undefined ? undefined : items.get(itemId), item: AssistantTaskItem = { ...input, id: itemId ?? input.id, taskId, followerBotId: id(8), version: String(BigInt(current?.version ?? "0") + 1n), createdAt: current?.createdAt ?? new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      items.set(item.id, structuredClone(item)); return structuredClone(item);
    }),
    listEvents: vi.fn(async (_task: string, query: { cursor?: string }) => page(events, query)),
    addEvent: vi.fn(async (_task, input) => { const event = { ...input, attention: ["report", "escalation", "result_unknown"].includes(input.type) } as AssistantTaskEvent; events.push(event); return event; }),
    listRecords: vi.fn(async (_task: string, query: { cursor?: string; itemId?: string }) => page(records.filter(record => record.itemId === query.itemId), query)),
    addRecord: vi.fn(async (_task, input) => { const record = input as AssistantTaskRecord; records.push(record); return record; }),
    getManual: vi.fn(async () => ({ version: "1", rules })),
  };
  const source = {
    scan: vi.fn(async () => { observation.session = { ...observation.session, freshUntil: new Date(now + 30_000).toISOString() }; return [structuredClone(observation)]; }),
    history: vi.fn(async () => ({ ...history })),
    send: vi.fn(async () => sendResult),
    operation: vi.fn(async () => operationResult),
  };
  const task = { id: id(7), manualVersion: "1" } as AssistantTask;
  const context: AssistantApplicationContext = { task, botId: id(8), signal: new AbortController().signal,
    withClaim: async action => { if (!allowed) throw new Error("claim_lost"); return action(api as unknown as AssistantTaskClient, task, { claimToken: "secret", claimGeneration: "1" }); },
  };
  const clock = { now: () => now, wait: async () => undefined };
  let evaluator = createWatchdogEvaluator(context, source as WatchdogSource, { clock });
  return {
    items, events, records, observation, history, api, source, task,
    tick: () => evaluator.tick(), advance: (ms: number) => { now += ms; }, now: () => now,
    rules: (value: JsonValue = rule) => { rules = value; }, loseClaim: () => { allowed = false; },
    sendResult: (value: string) => { sendResult = value; }, operationResult: (value: string) => { operationResult = value; },
    failSaveAfterSend: () => { failSaveAfterSend = true; },
    recover: (newHolder = false) => { if (newHolder) context.botId = id(9); evaluator = createWatchdogEvaluator(context, source as WatchdogSource, { clock }); },
    state: () => [...items.values()][0]!.appState as unknown as WatchdogState,
  };
};

// Every evaluator write passes through the production serializer, byte limit
// and response parser. The fixture controls storage and response loss only.
const productionWrites = (f: ReturnType<typeof fixture>, loseResultResponse = false) => {
  const operation = createOperation(), bytes: number[] = [];
  const saveItem = f.api.saveItem.getMockImplementation()!, addRecord = f.api.addRecord.getMockImplementation()!, addEvent = f.api.addEvent.getMockImplementation()!;
  const client = createAssistantTaskClient({ serverUrl: "http://localhost:3000", expectedUserId: id(1), botId: id(8), operation,
    fetch: async (url, init) => {
      bytes.push(Buffer.byteLength(init!.body as string));
      const body = JSON.parse(init!.body as string), path = new URL(String(url)).pathname, at = new Date(f.now()).toISOString();
      let value: unknown;
      if (path.includes("/items")) value = await saveItem(id(7), body, init!.method === "PATCH" ? path.split("/").at(-1) : undefined);
      else if (path.endsWith("/records")) {
        value = { ...await addRecord(id(7), body), taskId: id(7), author: "bot", authorBotId: id(8), createdAt: at };
        delete (value as Record<string, unknown>).claimToken; delete (value as Record<string, unknown>).claimGeneration;
      } else {
        value = { ...await addEvent(id(7), body), taskId: id(7), state: "pending", createdAt: at, deliveredAt: null, seenAt: null, ackOperationId: null };
        delete (value as Record<string, unknown>).claimToken; delete (value as Record<string, unknown>).claimGeneration;
        if (loseResultResponse && ["direct_success", "result_unknown", "escalation"].includes(body.type)) { loseResultResponse = false; throw new Error("Lost committed result response"); }
      }
      delete (value as Record<string, unknown>).claimToken; delete (value as Record<string, unknown>).claimGeneration;
      delete (value as Record<string, unknown>).ifVersion;
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "Daynight-User-ID": id(1) } });
    },
  });
  f.api.saveItem.mockImplementation((task, value, item) => client.saveItem(task, value, item));
  f.api.addRecord.mockImplementation((task, value) => client.addRecord(task, value));
  f.api.addEvent.mockImplementation((task, value) => client.addEvent(task, value));
  return { bytes, close: () => operation.dispose() };
};

describe("Watchdog persistent evaluator", () => {
  it("restarts the quiet interval when production history reconnects with unchanged durable entries", async () => {
    const f = fixture(); f.rules(); let epoch = id(40);
    const source = createWatchdogSource(id(1), (async (_signal, action) => action({
      readTaskSession: async () => ({ source: "live", historyEpoch: epoch, coverage: { state: "complete" }, hasMoreBefore: false, beforeCursor: null,
        items: [
          { entryId: id(30), revision: "1", kind: "user_message", timestamp: null, truncated: false, body: { kind: "user_message", origin: "daynight" } },
          { entryId: id(31), revision: "1", kind: "assistant_message", timestamp: null, truncated: false, body: { kind: "assistant_message", content: [{ type: "text", text: "Please continue" }] } },
        ],
      }),
    } as never)) as WatchdogApiScope);
    f.source.history.mockImplementation(() => source.history(f.observation, new AbortController().signal));
    await f.tick(); f.advance(600_000); await f.tick(); f.advance(60_000); await f.tick();
    epoch = id(41); f.advance(60_000); await f.tick();
    expect(f.state().inputQuiet?.since).toBe(f.now()); expect(f.source.send).not.toHaveBeenCalled();
    f.advance(60_000); await f.tick(); expect(f.source.send).not.toHaveBeenCalled();
    f.advance(60_000); await f.tick(); expect(f.source.send).toHaveBeenCalledOnce();
    expect(f.state().attempt!.progressId).toBe(`${id(31)}/1`);
  });
  it.each(["confirmed", "unknown", "rejected"])("keeps large action evidence writable across %s recovery and later tasks", async outcome => {
    const f = fixture(), message = "m".repeat(600 * 1024), largeRuleId = "r".repeat(200 * 1024);
    const ruleValue = [{ id: largeRuleId, category: "stalled", action: { kind: "send_message", message } }];
    f.rules(ruleValue); f.sendResult(outcome); f.operationResult("confirmed");
    const writes = productionWrites(f, true);
    try {
      // These large fields exercise report and quiet-proof storage alongside
      // the action. JSON escaping would amplify a nested literal identity.
      f.history.lastAssistantText = "\\\"".repeat(60 * 1024); f.history.lastInputAt = null; f.history.untimedInputId = "input";
      f.observation.title = "t".repeat(200 * 1024);
      await f.tick();
      for (let n = 0; n < 9; n++) { f.advance(60_000); await f.tick(); }
      f.advance(60_000); await expect(f.tick()).rejects.toThrow();
      expect(f.source.send).toHaveBeenCalledOnce();
      expect((f.source.send.mock.calls as unknown[][])[0]![2]).toBe(message);
      f.recover(true); await f.tick();
      expect(f.state().attempt).toMatchObject({ manualVersion: "1", ruleIndex: 0, messageEvidence: { bytes: message.length, truncated: true }, ruleIdEvidence: { bytes: largeRuleId.length, truncated: true } });
      expect(ruleValue[f.state().attempt!.ruleIndex!]!.action.message).toBe(message);
      expect(f.state().notices).toEqual([]);
      const following = { ...f.observation, taskId: id(20), session: { ...f.observation.session, sessionId: null, freshUntil: null, reason: "not_registered", registration: "not_registered" as const } };
      f.source.scan.mockImplementation(async () => { f.observation.session = { ...f.observation.session, freshUntil: new Date(f.now() + 30_000).toISOString() }; return [structuredClone(f.observation), following]; });
      await f.tick(); f.advance(600_000); await f.tick();
      expect(f.events.some(event => event.type === "escalation")).toBe(true);
      expect(f.events.some(event => event.type === "report" && (event.payload as { taskId: string }).taskId === id(20))).toBe(true);
      Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" });
      await f.tick();
      expect(f.events.some(event => event.type === "resolved")).toBe(true);
      expect(f.source.send).toHaveBeenCalledOnce();
      expect(Math.max(...writes.bytes)).toBeLessThan(64 * 1024);
    } finally { writes.close(); }
  });

  it("bounds error and title snapshots in report and resolution without changing execution identity", async () => {
    const f = fixture(), writes = productionWrites(f);
    f.observation.title = "t".repeat(200 * 1024);
    f.observation.session = { ...f.observation.session, error: { code: "unavailable", message: "e".repeat(600 * 1024) } };
    try {
      await f.tick(); f.advance(900_000); await f.tick();
      f.observation.inScope = false; await f.tick();
      expect(f.events.map(event => event.type)).toEqual(["report", "resolved"]);
      expect(f.events[1]!.payload).toMatchObject({ before: { session: { sessionId: id(3), claimId: id(5) }, textEvidence: { title: { truncated: true }, "session.error.message": { bytes: 600 * 1024, truncated: true } } } });
      expect(Math.max(...writes.bytes)).toBeLessThan(64 * 1024);
    } finally { writes.close(); }
  });

  it("references a legacy full action message without duplicating or discarding it", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000); await f.tick();
    const message = "m".repeat(600 * 1024), state = f.state();
    state.attempt!.message = message; state.attempt!.ruleId = "r".repeat(200 * 1024); state.attempt!.notifiedResult = null;
    delete state.attempt!.manualVersion; delete state.attempt!.ruleIndex; delete state.attempt!.messageEvidence; delete state.attempt!.ruleIdEvidence;
    const writes = productionWrites(f);
    try {
      f.recover(true); await f.tick();
      expect(f.state().attempt!.message).toBe(message);
      expect(f.records.at(-1)!.refs).toMatchObject({ messageRef: { itemId: [...f.items.keys()][0], path: "appState.attempt.message" }, messageEvidence: { bytes: message.length, truncated: true } });
      expect(Math.max(...writes.bytes)).toBeLessThan(900 * 1024);
      expect(f.source.send).toHaveBeenCalledOnce();
    } finally { writes.close(); }
  });
  it.each<WatchdogCategory>(["stalled", "disconnected", "waiting_input", "no_execution", "unobservable"])("reports %s once after its fixed duration", async category => {
    const f = fixture();
    if (category === "disconnected") Object.assign(f.observation.session, { reason: "disconnected", connectionState: "disconnected" });
    if (category === "waiting_input") Object.assign(f.observation.session, { reason: "waiting_input", indicator: "notice", activity: "waiting_input" });
    if (category === "no_execution") Object.assign(f.observation.session, { reason: "not_registered", registration: "not_registered", sessionId: null });
    if (category === "unobservable") Object.assign(f.observation.session, { observation: "unavailable" });
    if (category !== "stalled") f.rules();
    await f.tick(); f.advance(WATCHDOG_DURATION[category] - 1); await f.tick();
    expect(f.events).toEqual([]);
    f.advance(1); await f.tick(); await f.tick();
    expect(f.events.map(event => event.type)).toEqual(["report"]);
    expect(f.state().reportedAt).toBe(f.now());
    expect(f.events[0]!.payload).toMatchObject({ category });
    expect(f.source.send).not.toHaveBeenCalled();
  });

  it("does not report brief inter-turn idle or out-of-scope tasks", async () => {
    const f = fixture(); await f.tick(); f.advance(300_000);
    Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" });
    await f.tick(); f.advance(600_000); await f.tick();
    expect(f.events).toEqual([]);
    expect([...f.items.values()][0]!.state).toBe("closed");
    f.observation.inScope = false; Object.assign(f.observation.session, { activity: "idle", reason: "idle", indicator: "warning" });
    await f.tick(); expect(f.events).toEqual([]);
  });

  it("updates one item when category changes and retains elapsed timing across takeover", async () => {
    const f = fixture(); await f.tick(); f.advance(600_000); await f.tick();
    const original = [...f.items.keys()][0];
    Object.assign(f.observation.session, { indicator: "notice", activity: "waiting_input", reason: "waiting_input" });
    await f.tick(); f.advance(599_999); f.recover(); await f.tick();
    expect(f.events.map(event => event.type)).toEqual(["report"]);
    f.advance(1); await f.tick();
    expect([...f.items.keys()]).toEqual([original]);
    expect(f.events.map(event => event.type)).toEqual(["report", "update"]);
  });

  it("reopens a same-category recurrence within thirty minutes without another direct action", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000); await f.tick();
    expect(f.source.send).toHaveBeenCalledTimes(1);
    const original = [...f.items.keys()][0];
    Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" });
    f.advance(60_000); await f.tick();
    expect(f.events.at(-1)!.type).toBe("resolved");
    expect(f.events.at(-1)!.payload).toMatchObject({ before: { session: { activity: "idle" } }, after: { session: { activity: "working" } } });
    Object.assign(f.observation.session, { activity: "idle", reason: "idle", indicator: "warning" });
    f.advance(1_800_000); await f.tick(); f.advance(600_000); await f.tick();
    expect([...f.items.keys()]).toEqual([original]);
    expect(f.state().recurrence).toBe(true);
    expect(f.source.send).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)!.type).toBe("report");
  });

  it("starts a new episode after the recurrence window", async () => {
    const f = fixture(); await f.tick(); f.advance(600_000); await f.tick();
    Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" }); await f.tick();
    Object.assign(f.observation.session, { activity: "idle", reason: "idle", indicator: "warning" });
    f.advance(1_800_001); await f.tick();
    expect([...f.items.values()].map(item => item.episode)).toEqual(["1", "2"]);
  });

  it.each([false, true])("retains recurrence identity through an unreported short reopening (prior action: %s)", async priorAction => {
    const f = fixture(); if (priorAction) f.rules();
    await f.tick(); f.advance(600_000); await f.tick();
    const original = [...f.items.keys()][0], attempt = f.state().attempt;
    const recover = async () => { Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" }); await f.tick(); };
    const reopen = async () => { f.advance(60_000); Object.assign(f.observation.session, { activity: "idle", reason: "idle", indicator: "warning" }); await f.tick(); };
    await recover(); await reopen(); f.advance(60_000); await recover();
    f.recover(true); f.rules(); await reopen(); f.advance(600_000); await f.tick();
    expect([...f.items.keys()]).toEqual([original]);
    expect(f.state().recurrence).toBe(true);
    expect(f.state().attempt?.operationId ?? null).toBe(attempt?.operationId ?? null);
    expect(f.source.send).toHaveBeenCalledTimes(priorAction ? 1 : 0);
    expect(f.events.filter(event => event.type === "report")).toHaveLength(2);
  });

  it("proves untimed input quiet across complete stable polls and holder recovery", async () => {
    const f = fixture(); f.rules(); f.history.lastInputAt = null; f.history.untimedInputId = "epoch/input/1";
    await f.tick(); f.advance(600_000); await f.tick();
    expect(f.source.send).not.toHaveBeenCalled();
    f.advance(60_000); await f.tick(); f.recover(true); f.advance(60_000); await f.tick();
    expect(f.source.send).toHaveBeenCalledOnce();
  });

  it.each(["input", "epoch", "fence", "incomplete", "gap", "clock"])("restarts untimed quiet evidence after %s changes", async change => {
    const f = fixture(); f.rules(); f.history.lastInputAt = null; f.history.untimedInputId = "epoch/input/1";
    await f.tick(); f.advance(600_000); await f.tick(); f.advance(60_000); await f.tick();
    if (change === "input") f.history.untimedInputId = "epoch/new-input/1";
    if (change === "epoch") f.history.untimedInputId = "new-epoch/input/1";
    if (change === "fence") f.observation.session = { ...f.observation.session, connectionEpoch: "2" };
    if (change === "incomplete") f.history.complete = false;
    f.advance(change === "gap" ? 120_001 : change === "clock" ? -1 : 60_000); await f.tick();
    expect(f.source.send).not.toHaveBeenCalled();
    f.history.complete = true; await f.tick();
    f.advance(60_000); await f.tick(); expect(f.source.send).not.toHaveBeenCalled();
    f.advance(60_000); await f.tick(); expect(f.source.send).toHaveBeenCalledOnce();
  });

  it("starts the quiet interval only after a slow history read supplies its evidence", async () => {
    const f = fixture(); await f.tick(); f.rules(); f.advance(600_000);
    f.history.lastInputAt = null; f.history.untimedInputId = "epoch/new-input/1";
    f.source.history.mockImplementationOnce(async () => { f.advance(50_000); return { ...f.history }; });
    await f.tick();
    expect(f.state().inputQuiet?.since).toBe(start + 650_000);
    f.advance(10_000); await f.tick(); f.advance(60_000); await f.tick();
    expect(f.source.send).not.toHaveBeenCalled();
    f.advance(50_000); await f.tick(); expect(f.source.send).toHaveBeenCalledOnce();
  });

  it("attempts one action and escalates after ten minutes without progress", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000); await f.tick();
    expect(f.events.map(event => event.type)).toEqual(["report", "direct_success"]);
    expect(f.events[1]!.attention).toBe(false);
    f.advance(599_999); await f.tick(); expect(f.events).toHaveLength(2);
    f.advance(1); await f.tick(); await f.tick();
    expect(f.events.map(event => event.type)).toEqual(["report", "direct_success", "escalation"]);
    expect(f.source.send).toHaveBeenCalledTimes(1);
    expect(f.records.find(record => record.kind === "action")!.refs).toMatchObject({ ruleId: "continue", message: "Continue the assigned task." });
  });

  it("does not escalate after new native history", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000); await f.tick();
    f.history.lastEntryId = "entry-2"; f.history.lastProgressId = "entry-2"; f.advance(600_000); await f.tick();
    expect(f.events.some(event => event.type === "escalation")).toBe(false);
  });

  it("queries the original operation after an unknown send and a lost state update", async () => {
    const f = fixture(); f.rules(); f.sendResult("unknown"); await f.tick(); f.advance(600_000);
    f.failSaveAfterSend(); await expect(f.tick()).rejects.toThrow("lost item response");
    const original = f.state().attempt!.operationId;
    f.recover(); f.advance(60_000); await f.tick(); await f.tick();
    expect(f.source.send).toHaveBeenCalledTimes(1);
    expect(f.state().attempt!.operationId).toBe(original);
    expect(f.events.filter(event => event.type === "result_unknown")).toHaveLength(1);
    f.operationResult("confirmed"); await f.tick();
    expect(f.events.at(-1)!.type).toBe("direct_success");
    expect(f.source.send).toHaveBeenCalledTimes(1);
  });

  it("starts follow-up after slow history, manual, intent persistence and sending finish", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000);
    f.source.history.mockImplementationOnce(async () => { f.advance(50_000); return { ...f.history }; });
    const manual = f.api.getManual.getMockImplementation()!, save = f.api.saveItem.getMockImplementation()!;
    f.api.getManual.mockImplementationOnce(async () => { f.advance(40_000); return manual(); });
    let delayedIntent = false;
    f.api.saveItem.mockImplementation(async (...args) => {
      if (!delayedIntent && args[1].appState.attempt !== null) { delayedIntent = true; f.advance(20_000); }
      return save(...args);
    });
    f.source.send.mockImplementationOnce(async () => { f.advance(30_000); return "confirmed"; });
    await f.tick();
    const attempt = f.state().attempt!;
    expect(attempt.at).toBe(start + 690_000);
    expect(attempt.followUpSince).toBe(start + 740_000);
    f.advance(599_999); await f.tick(); expect(f.events.some(event => event.type === "escalation")).toBe(false);
    f.advance(1); await f.tick();
    expect(f.events.at(-1)!.payload).toMatchObject({ attemptedAt: attempt.at, followUpSince: attempt.followUpSince });
    expect(f.events.at(-1)!.type).toBe("escalation");
  });

  it.each([false, true])("observes the persisted baseline after a lost post-send save (committed: %s)", async committed => {
    const f = fixture(); f.rules(); f.sendResult("unknown"); await f.tick(); f.advance(600_000);
    const save = f.api.saveItem.getMockImplementation()!;
    let failed = false;
    f.api.saveItem.mockImplementation(async (...args) => {
      if (!failed && args[1].appState.attempt?.followUpSince !== undefined) {
        failed = true; if (committed) await save(...args);
        throw new Error("post-send response lost");
      }
      return save(...args);
    });
    await expect(f.tick()).rejects.toThrow("post-send response lost");
    const original = structuredClone(f.state().attempt!);
    expect(original.followUpSince).toBe(committed ? start + 600_000 : undefined);
    f.recover(true); f.advance(120_000);
    f.source.operation.mockImplementationOnce(async () => { f.advance(30_000); return "unknown"; });
    await f.tick();
    const baseline = f.state().attempt!.followUpSince!;
    expect(baseline).toBe(committed ? start + 600_000 : start + 750_000);
    expect(f.state().attempt!.at).toBe(original.at);
    expect(f.state().attempt!.operationId).toBe(original.operationId);
    f.advance(600_000 - (f.now() - baseline) - 1); await f.tick();
    expect(f.state().attempt!.followUpSince).toBe(baseline);
    expect(f.events.some(event => event.type === "escalation")).toBe(false);
    f.advance(1); await f.tick(); expect(f.events.at(-1)!.type).toBe("escalation");
    expect(f.source.send).toHaveBeenCalledOnce();
  });

  it.each(["confirmed", "unknown"])("initializes a legacy %s attempt only after querying its original operation", async result => {
    const f = fixture(); f.rules(); f.sendResult(result); await f.tick(); f.advance(600_000); await f.tick();
    const original = structuredClone(f.state().attempt!);
    delete f.state().attempt!.followUpSince;
    f.recover(true); f.advance(1_200_000);
    f.source.operation.mockImplementationOnce(async () => { f.advance(30_000); throw new Error("operation unavailable"); });
    await f.tick(); const baseline = f.state().attempt!.followUpSince!;
    expect(baseline).toBe(f.now()); expect(f.state().attempt!.at).toBe(original.at);
    expect(f.state().attempt!.result).toBe(result);
    expect(f.events.some(event => event.type === "escalation")).toBe(false);
    f.advance(599_999); await f.tick(); expect(f.events.some(event => event.type === "escalation")).toBe(false);
    f.advance(1); await f.tick(); expect(f.events.at(-1)!.type).toBe("escalation");
    expect(f.source.send).toHaveBeenCalledOnce();
  });

  it("reconciles an outbox event with a lost response after a new holder resumes", async () => {
    const f = fixture(); await f.tick(); f.advance(600_000);
    f.api.addEvent.mockImplementationOnce(async (_task, input) => {
      const event = input as AssistantTaskEvent; f.events.push(event);
      throw new Error("event response lost after commit");
    });
    await expect(f.tick()).rejects.toThrow("event response lost");
    const original = f.state().notices[0]!.id;
    expect(f.events[0]!.id).toBe(original);
    f.recover(true); await f.tick();
    expect(f.state().notices).toEqual([]);
    expect(f.api.addEvent).toHaveBeenCalledTimes(1);
    expect(f.records).toHaveLength(1);
  });

  it("does not resurrect a stale queued report after the target resumes", async () => {
    const f = fixture(); await f.tick(); f.advance(600_000);
    f.api.addRecord.mockRejectedValueOnce(new Error("record unavailable"));
    await expect(f.tick()).rejects.toThrow("record unavailable");
    expect(f.state().notices[0]!.type).toBe("report");
    Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" });
    f.recover(); await f.tick();
    expect(f.events.map(event => event.type)).toEqual(["resolved"]);
    expect(f.state().notices).toEqual([]);
  });

  it("replaces an unsubmitted report when its category changed during recovery", async () => {
    const f = fixture(); await f.tick(); f.advance(600_000);
    f.api.addRecord.mockRejectedValueOnce(new Error("record unavailable"));
    await expect(f.tick()).rejects.toThrow();
    Object.assign(f.observation.session, { reason: "disconnected", connectionState: "disconnected" });
    f.recover(); await f.tick();
    expect(f.events).toEqual([]);
    f.advance(300_000); await f.tick();
    expect(f.events.map(event => event.type)).toEqual(["report"]);
    expect(f.events[0]!.payload).toMatchObject({ category: "disconnected" });
  });

  it("keeps querying an old unresolved operation after a later episode opens", async () => {
    const f = fixture(); f.rules(); f.sendResult("unknown"); await f.tick(); f.advance(600_000); await f.tick();
    const original = f.state().attempt!.operationId;
    Object.assign(f.observation.session, { activity: "working", reason: "working", indicator: "working" }); await f.tick();
    Object.assign(f.observation.session, { activity: "idle", reason: "idle", indicator: "warning" });
    f.advance(1_800_001); f.source.operation.mockClear(); await f.tick();
    expect(f.items.size).toBe(2);
    expect(f.source.operation).toHaveBeenCalled();
    expect(f.state().attempt!.operationId).toBe(original);
    f.operationResult("confirmed"); await f.tick();
    expect(f.state().attempt!.result).toBe("confirmed");
  });

  it("refuses direct handling after recent input, incomplete history, or denied sending", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000);
    f.history.lastInputAt = f.now() - 119_999; await f.tick(); expect(f.source.send).not.toHaveBeenCalled();
    f.advance(1); f.history.complete = false; await f.tick(); expect(f.source.send).not.toHaveBeenCalled();
    f.history.complete = true; f.observation.session = { ...f.observation.session, send: { ...f.observation.session.send, allowed: false } }; await f.tick(); expect(f.source.send).not.toHaveBeenCalled();
    f.observation.session = { ...f.observation.session, send: { ...f.observation.session.send, allowed: true } }; await f.tick(); expect(f.source.send).toHaveBeenCalledTimes(1);
  });

  it("honors a lost claim before writing or sending", async () => {
    const f = fixture(); f.rules(); await f.tick(); f.advance(600_000); f.loseClaim();
    await expect(f.tick()).rejects.toThrow("claim_lost");
    expect(f.source.send).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });

  it("does not close an item on inventory failure or an omitted observation", async () => {
    const f = fixture(); await f.tick(); f.source.scan.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.tick()).rejects.toThrow("unavailable");
    f.source.scan.mockResolvedValueOnce([]); await f.tick();
    expect([...f.items.values()][0]!.state).toBe("open");
  });

  it("closes a task observed outside scope and preserves before/after evidence", async () => {
    const f = fixture(); await f.tick(); f.advance(600_000); await f.tick(); f.observation.inScope = false; await f.tick();
    expect(f.events.at(-1)!.type).toBe("resolved");
    expect(f.events.at(-1)!.payload).toMatchObject({ after: { inScope: false } });
  });
});

describe("Watchdog observation precedence", () => {
  it("classifies stale idle, disconnected and input states as unobservable", () => {
    const observation: WatchdogObservation = { projectId: id(1), taskId: id(2), title: "Task", inScope: true, session: session() };
    for (const reason of ["idle", "disconnected", "waiting_input"]) {
      observation.session = { ...session(), reason, freshUntil: new Date(start).toISOString() };
      expect(classifyWatchdogObservation(observation, start)).toBe("unobservable");
    }
  });
  it("distinguishes stopped activity and unknown observation from working", () => {
    const observation: WatchdogObservation = { projectId: id(1), taskId: id(2), title: "Task", inScope: true, session: { ...session(), activity: "stopped", reason: "stopped" } };
    expect(classifyWatchdogObservation(observation, start)).toBe("disconnected");
    observation.session = { ...session(), indicator: null, activity: "unknown", reason: "unknown" };
    expect(classifyWatchdogObservation(observation, start)).toBe("unobservable");
  });
});
