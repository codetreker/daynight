import { describe, expect, it, vi } from "vitest";
import type { AssistantTask, AssistantTaskClient, AssistantTaskEvent, AssistantTaskItem, AssistantTaskRecord, JsonValue } from "../../../../src/api/assistant-task.js";
import type { TaskSessionObservation } from "../../../../src/api/task-observation.js";
import type { AssistantApplicationContext } from "../../../../src/commands/worker/bots/assistant-tasks.js";
import { classifyWatchdogObservation, createWatchdogEvaluator, WATCHDOG_DURATION, type WatchdogCategory, type WatchdogHistory, type WatchdogObservation, type WatchdogSource, type WatchdogState } from "../../../../src/commands/worker/bots/apps/watchdog.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const start = Date.parse("2026-11-13T00:00:00Z");
const session = (): TaskSessionObservation => ({ schemaVersion: 1, observation: "observed", registration: "registered", sessionId: id(3), nativeSessionId: id(4), claimId: id(5), executionGeneration: "1", connectionEpoch: "1", agentControlMode: "web", contentKind: "native_timeline", provider: "codex", indicator: "warning", reason: "idle", activity: "idle", connectionState: "connected", lifecycle: "active", currentTurnId: null, needsAttention: false, send: { allowed: true, mode: "start", reason: "allowed" }, observedAt: new Date(start).toISOString(), lastSeenAt: new Date(start).toISOString(), freshUntil: new Date(start + 30_000).toISOString(), error: null });
const rule: JsonValue = [{ id: "continue", category: "stalled", match: { contains: "continue" }, action: { kind: "send_message", message: "Continue the assigned task." } }];

const fixture = () => {
  let now = start, allowed = true, sendResult = "confirmed", operationResult = "unknown", failSaveAfterSend = false;
  let rules: JsonValue = [];
  const observation: WatchdogObservation = { projectId: id(1), taskId: id(2), title: "Task", inScope: true, session: session() };
  const history: WatchdogHistory = { complete: true, lastEntryId: "entry-1", lastAssistantText: "Please continue", lastInputAt: start - 300_000 };
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
    rules: () => { rules = rule; }, loseClaim: () => { allowed = false; },
    sendResult: (value: string) => { sendResult = value; }, operationResult: (value: string) => { operationResult = value; },
    failSaveAfterSend: () => { failSaveAfterSend = true; },
    recover: (newHolder = false) => { if (newHolder) context.botId = id(9); evaluator = createWatchdogEvaluator(context, source as WatchdogSource, { clock }); },
    state: () => [...items.values()][0]!.appState as unknown as WatchdogState,
  };
};

describe("Watchdog persistent evaluator", () => {
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
    f.history.lastEntryId = "entry-2"; f.advance(600_000); await f.tick();
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
