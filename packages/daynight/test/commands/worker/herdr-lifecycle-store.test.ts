import path from "node:path";
import { expect, it } from "vitest";
import { createHerdrLifecycleStoreFixtures } from "./herdr-lifecycle-store.fixtures.js";

const { uuid, identity, start, finish, fixture, processIdentity, prepared, active, stopped } = createHerdrLifecycleStoreFixtures("memory");

it("keeps launch uncertainty and original process identities across recovery", () => {
    const f = fixture(); let record = active(f);
    const evidence = record.runs[0]!.processes;
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "stop_unknown"; draft.runs[0]!.admission = null; draft.runs[0]!.error = "probe unavailable"; });
    expect(f.store.recover(record).runs[0]).toMatchObject({ phase: "stop_unknown", processes: evidence });
    const current = f.store.get(identity)!;
    expect(() => f.store.update(current, draft => { draft.runs[0]!.processes[0]!.birthToken = "replacement"; })).toThrow();
    expect(() => f.store.update(current, draft => { draft.runs.push({ ...prepared(f.directory), run: { ...prepared(f.directory).run, executionGeneration: "2" } }); })).toThrow();
  });

it("blocks replacement daemon preparation until the original run has stopped", () => {
    const f = fixture(), record = active(f);
    expect(() => f.store.update(record, draft => { draft.preparation = { instanceId: "replacement", instanceDirectory: path.join(f.directory, "next"), phase: "prepared", daemon: null }; })).toThrow();
  });

it("requires a committed intent before retrying an unknown close", () => {
    const f = fixture(); let record = active(f);
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "stop_unknown"; draft.runs[0]!.admission = null; });
    expect(() => f.store.update(record, draft => { draft.runs[0]!.phase = "close_requested"; draft.runs[0]!.stopOperationId = uuid(8); draft.runs[0]!.stopReason = "shutdown"; })).toThrow();
  });

it("rejects mixed-boot launch evidence and rolls back callback failures", () => {
    const f = fixture(); let record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.nativeLaunch = "requested"; draft.runs[0]!.daemon = processIdentity("daemon", 101); });
    expect(() => f.store.update(record, draft => { draft.runs[0]!.phase = "active"; draft.runs[0]!.nativeLaunch = "observed"; draft.runs[0]!.processes = [processIdentity("shell", 102), { ...processIdentity("agent", 103), bootId: "other-boot" }]; })).toThrow();
    expect(() => f.store.update(record, draft => { draft.initialPrompt = "lost"; throw new Error("probe failed"); })).toThrow("probe failed");
    expect(f.store.get(identity)).toEqual(record);
  });

it("blocks automation after recovering an unresolved admitted input", () => {
    const f = fixture(), record = active(f);
    expect(f.store.recover(record).automationBlocked).toBe(true);
  });

it("appends proven descendants during stopping without changing their original parents", () => {
    const f = fixture(); let record = active(f);
    record = f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "stop_intent"; run.stopOperationId = uuid(8); run.stopReason = "shutdown"; run.admission = null; });
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "close_requested"; });
    const descendant = { ...processIdentity("agent", 104), ppid: 103, sid: 103 };
    record = f.store.update(record, draft => { draft.runs[0]!.processes.push(descendant); });
    expect(record.runs[0]!.processes.at(-1)).toEqual(descendant);
    expect(() => f.store.update(record, draft => { draft.runs[0]!.processes.push({ ...processIdentity("agent", 105), ppid: 999 }); })).toThrow();
    expect(() => f.store.update(record, draft => { draft.runs[0]!.processes[0]!.pid = 999; })).toThrow();
  });

it("requires durable stop intent and original proof before confirming stopped", () => {
    const f = fixture(), record = active(f);
    expect(() => f.store.update(record, draft => { draft.runs[0]!.phase = "close_requested"; })).toThrow();
    expect(() => f.store.update(record, draft => { draft.runs[0]!.phase = "stopped_confirmed"; })).toThrow();
    const complete = stopped(f, record);
    expect(complete.runs[0]!.phase).toBe("stopped_confirmed");
    expect(() => f.store.update(complete, draft => { draft.runs[0]!.run.binding.nativeSessionId = uuid(50); })).toThrow();
    expect(() => f.store.update(complete, draft => { draft.runs.push({ ...prepared(f.directory), run: { ...prepared(f.directory).run, executionGeneration: "2" } }); })).toThrow();
  });

it("allows only a same-native next generation following a confirmed stop", () => {
    const f = fixture(); let record = active(f);
    record = f.store.update(record, draft => { draft.runs[0]!.run.binding.nativeSessionId = uuid(50); });
    record = stopped(f, record);
    const next = prepared(path.join(f.directory, "next")); next.run.executionGeneration = "2"; next.run.startedAt = finish;
    next.run.binding = { ...next.run.binding, instanceId: "daemon-two", workspaceId: "workspace-two", terminalId: "terminal-two", nativeSessionId: uuid(50) };
    const advanced = f.store.update(record, draft => { draft.runs.push(next); });
    expect(advanced.runs.map(run => run.run.executionGeneration)).toEqual(["1", "2"]);
    expect(advanced.sessionId).toBe(record.sessionId);
    expect(() => f.store.update(advanced, draft => { draft.runs[1]!.run.binding.nativeSessionId = uuid(51); })).toThrow();
  });

it("enriches the original native identity on a closed capture segment without changing its observation boundary", () => {
  const f = fixture(); let record = active(f);
  record = f.store.update(record, draft => {
    draft.runs[0]!.run.segmentIds.push(uuid(20));
    draft.segments.push({ segmentId: uuid(20), segmentOrdinal: "1", executionGeneration: "1", binding: { ...draft.runs[0]!.run.binding }, startedAt: start, endedAt: finish, durationMs: "60000", gap: null });
  });
  const enriched = f.store.update(record, draft => { draft.runs[0]!.run.binding.nativeSessionId = uuid(99); draft.segments[0]!.binding.nativeSessionId = uuid(99); });
  expect(enriched.segments[0]!.endedAt).toBe(finish);
  expect(() => f.store.update(enriched, draft => { draft.segments[0]!.durationMs = "61000"; })).toThrow();
});

it("does not retire stale or started lifecycle evidence", () => {
  const f = fixture(), stale = f.record;
  f.store.update(stale, draft => { draft.preparation = { instanceId: "original", instanceDirectory: f.directory, phase: "launch_requested", daemon: null }; });
  expect(() => f.store.retireNeverStarted(stale)).toThrow(/changed/);
  expect(() => f.store.retireNeverStarted(f.store.get(identity)!)).toThrow(/changed/);
  expect(f.store.listRetired()).toEqual([]);
});
