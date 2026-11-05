import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { herdrLedgerHash, herdrLedgerPayloadHash, openHerdrLifecycleStore, readHerdrLifecycleRecords, type HerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleRecord, HerdrLocalRun, MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { projectId: uuid(1), taskId: uuid(2), workerId: uuid(3), worktreeId: uuid(4), ownerUserId: uuid(5), serverOrigin: "https://daynight.example", provider: "codex" as const };
const identity = { projectId: owner.projectId, taskId: owner.taskId, claimId: uuid(6) };
const start = "2026-11-04T00:00:00.000Z";
const finish = "2026-11-04T00:01:00.000Z";
const root = fileURLToPath(new URL("../../../../../.tmp/herdr-lifecycle-store/", import.meta.url));
const stores = new Set<HerdrLifecycleStore>();
const directories: string[] = [];
const open = (file: string) => { const store = openHerdrLifecycleStore(file, { onMigration: () => {} }); stores.add(store); return store; };
const close = (store: HerdrLifecycleStore) => { store.close(); stores.delete(store); };
const fixture = () => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const file = path.join(directory, "herdr.sqlite"), store = open(file);
  const record = store.create({ owner, claimId: identity.claimId, cwd: directory }, start);
  return { directory, file, store, record };
};
const processIdentity = (role: MacProcessIdentity["role"], pid: number): MacProcessIdentity => ({ role, pid, birthToken: `1700000000:${pid}`, bootId: "boot-one", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: 1, pgid: pid, sid: pid });
const prepared = (directory: string): HerdrLocalRun => ({
  run: { executionGeneration: "1", owner, binding: { instanceId: "daemon-one", sessionId: "w", workspaceId: "workspace-one", paneId: "pane-one", terminalId: "terminal-one", nativeSessionId: null }, startedAt: start, stoppedAt: null, stopProof: null, segmentIds: [] },
  phase: "prepared", instanceDirectory: directory, daemon: null, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null,
});
const active = (f: ReturnType<typeof fixture>): HerdrLifecycleRecord => {
  let record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
  record = f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "launch_requested"; run.daemon = processIdentity("daemon", 101); });
  return f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "active"; run.processes = [processIdentity("shell", 102), processIdentity("agent", 103)]; run.admission = uuid(7); });
};
const stopped = (f: ReturnType<typeof fixture>, record: HerdrLifecycleRecord) => {
  record = f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "stop_intent"; run.stopOperationId = uuid(8); run.stopReason = "shutdown"; run.admission = null; });
  record = f.store.update(record, draft => { draft.runs[0]!.phase = "close_requested"; });
  return f.store.update(record, draft => {
    const local = draft.runs[0]!; local.phase = "stopped_confirmed"; local.run.stoppedAt = finish;
    local.run.stopProof = { recordId: uuid(8), executionGeneration: "1", binding: local.run.binding, bootId: "boot-one", stoppedAt: finish, method: "instances_exited", terminalStopped: true, processes: local.processes.map(({ role, pid, birthToken, bootId }) => ({ role: role as "shell" | "agent", pid, birthToken, bootId })) };
  });
};

afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("persistent Herdr lifecycle responsibility", () => {
  it("reads an existing journal without migration, recovery or epoch changes", () => {
    const f = fixture(); const record = active(f); close(f.store);
    const original = readFileSync(f.file);
    expect(readHerdrLifecycleRecords(f.file)).toEqual([record]);
    expect(readFileSync(f.file)).toEqual(original);
    expect(readHerdrLifecycleRecords(f.file)[0]!.controlEpoch).toBe(record.controlEpoch);
    expect(() => readHerdrLifecycleRecords(path.join(f.directory, "absent.sqlite"))).toThrow();
    expect(existsSync(path.join(f.directory, "absent.sqlite"))).toBe(false);
  });

  it("rejects an old or altered journal without upgrading or resetting evidence", () => {
    const f = fixture(); close(f.store);
    let db = new Database(f.file); db.pragma("user_version = 0"); db.close();
    const original = readFileSync(f.file);
    expect(() => readHerdrLifecycleRecords(f.file)).toThrow(); expect(readFileSync(f.file)).toEqual(original);
    db = new Database(f.file); db.pragma("user_version = 1"); db.exec("CREATE TABLE unexpected(value TEXT)"); db.close();
    expect(() => readHerdrLifecycleRecords(f.file)).toThrow();
    db = new Database(f.file); expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='unexpected'").get()).toBeDefined(); db.close();
  });

  it("retains the original Session and ownership across reopening and rejects rebinding", () => {
    const f = fixture(); const { sessionId, registrationId } = f.record;
    close(f.store); const recovered = open(f.file);
    expect(recovered.get(identity)).toMatchObject({ owner, sessionId, registrationId, claimId: identity.claimId, version: 1 });
    expect(recovered.create({ owner, claimId: identity.claimId, cwd: f.directory }, finish).sessionId).toBe(sessionId);
    expect(() => recovered.create({ owner: { ...owner, worktreeId: uuid(99) }, claimId: identity.claimId, cwd: f.directory }, finish)).toThrow();
    expect(recovered.list()).toHaveLength(1);
    const db = new Database(f.file); expect(db.pragma("journal_mode", { simple: true })).toBe("wal"); db.close();
  });

  it("rejects stale decisions without overwriting a concurrent stop intent", () => {
    const f = fixture(), record = active(f), second = open(f.file);
    const current = f.store.update(record, draft => { draft.runs[0]!.phase = "stop_intent"; draft.runs[0]!.stopOperationId = uuid(8); draft.runs[0]!.stopReason = "shutdown"; draft.runs[0]!.admission = null; });
    expect(() => second.update(record, draft => { draft.initialAssignment = "dispatching"; })).toThrow(/version|stale/i);
    expect(second.get(identity)).toEqual(current);
  });

  it("retains the last published ledger receipt without treating a later stop as published", () => {
    const f = fixture(); let record = active(f);
    const receipt = herdrLedgerHash(record);
    expect(() => f.store.update(record, draft => { draft.publishedLedgerHash = "0".repeat(64); })).toThrow();
    record = f.store.update(record, draft => { draft.publishedLedgerHash = receipt; });
    record = stopped(f, record);
    expect(record.publishedLedgerHash).toBe(receipt); expect(herdrLedgerHash(record)).not.toBe(receipt);
    close(f.store); const recovered = open(f.file);
    expect(recovered.get(identity)!.publishedLedgerHash).toBe(receipt);
    expect(() => recovered.update(record, draft => { draft.publishedLedgerHash = null; })).toThrow();
    const published = recovered.update(record, draft => { draft.publishedLedgerHash = herdrLedgerHash(draft); });
    expect(published.publishedLedgerHash).toBe(herdrLedgerHash(published));
  });

  it("preserves a pending publication through stopping and fences replacement or reconnection", () => {
    const f = fixture(); let record = active(f);
    record = f.store.update(record, draft => {
      draft.connectionEpoch = "1";
      draft.ledgerRequest = { connectionEpoch: "1", message: { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: draft.sessionId, claimId: draft.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "generation_ledger", payload: { runs: draft.runs.map(run => run.run), finalizationId: null } } };
    });
    expect(() => f.store.update(record, draft => { draft.ledgerRequest = null; })).toThrow();
    expect(() => f.store.update(record, draft => { draft.connectionEpoch = "2"; })).toThrow();
    expect(() => f.store.update(record, draft => { draft.ledgerRequest!.message.claimId = uuid(99); })).toThrow();
    const pending = structuredClone(record.ledgerRequest!);
    record = stopped(f, record);
    expect(() => f.store.update(record, draft => { draft.ledgerRequest!.message.payload.runs = draft.runs.map(run => run.run); })).toThrow();
    close(f.store); const recovered = open(f.file);
    expect(recovered.get(identity)!.ledgerRequest).toEqual(pending);
    record = recovered.update(record, draft => { draft.publishedLedgerHash = herdrLedgerPayloadHash(pending.message.payload); draft.ledgerRequest = null; });
    expect(record.publishedLedgerHash).not.toBe(herdrLedgerHash(record));
  });

  it("retains pre-binding preparation and the first prompt without fabricating a run", () => {
    const f = fixture();
    const record = f.store.update(f.record, draft => {
      draft.preparation = { instanceId: "daemon-one", instanceDirectory: f.directory, phase: "prepared", daemon: null };
      draft.initialPrompt = "Original managed assignment";
    });
    close(f.store); const recovered = open(f.file);
    expect(recovered.get(identity)).toMatchObject({ initialPrompt: "Original managed assignment", preparation: { phase: "prepared", instanceId: "daemon-one" }, runs: [] });
    expect(() => recovered.update(record, draft => { draft.initialPrompt = "Replacement assignment"; })).toThrow();
    expect(() => recovered.update(record, draft => { draft.preparation = { ...draft.preparation!, instanceId: "other-daemon" }; })).toThrow();
  });

  it("does not admit input before birth evidence or dispatch again after unknown", () => {
    const f = fixture();
    expect(() => f.store.update(f.record, draft => { draft.runs.push({ ...prepared(f.directory), phase: "active", admission: uuid(7) }); })).toThrow();
    let record = active(f);
    record = f.store.update(record, draft => { draft.initialAssignment = "dispatching"; });
    close(f.store); const recovered = open(f.file);
    record = recovered.recover(recovered.get(identity)!);
    expect(record.initialAssignment).toBe("unknown"); expect(record.runs[0]!.admission).toBeNull();
    expect(record.controlEpoch).toBe("1");
    expect(() => recovered.update(record, draft => { draft.initialAssignment = "pending"; })).toThrow();
  });

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
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.daemon = processIdentity("daemon", 101); });
    expect(() => f.store.update(record, draft => { draft.runs[0]!.phase = "active"; draft.runs[0]!.processes = [processIdentity("shell", 102), { ...processIdentity("agent", 103), bootId: "other-boot" }]; })).toThrow();
    expect(() => f.store.update(record, draft => { draft.initialPrompt = "lost"; throw new Error("probe failed"); })).toThrow("probe failed");
    expect(f.store.get(identity)).toEqual(record);
  });

  it("keeps continuation uncertainty separate from a delivered initial assignment", () => {
    const f = fixture(); let record = active(f);
    record = f.store.update(record, draft => { draft.initialAssignment = "dispatching"; });
    record = f.store.update(record, draft => { draft.initialAssignment = "transport_completed"; draft.runs[0]!.admission = null; });
    record = f.store.update(record, draft => { draft.automationBlocked = true; });
    expect(record.initialAssignment).toBe("transport_completed");
    close(f.store); const recovered = open(f.file);
    expect(recovered.get(identity)!.automationBlocked).toBe(true);
    expect(() => recovered.update(recovered.get(identity)!, draft => { draft.automationBlocked = false; })).toThrow();
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

  it("persists segment ownership and rejects ordinal reuse or post-stop additions", () => {
    const f = fixture(); let record = active(f);
    record = f.store.update(record, draft => {
      draft.runs[0]!.run.segmentIds.push(uuid(20));
      draft.segments.push({ segmentId: uuid(20), segmentOrdinal: "1", executionGeneration: "1", binding: draft.runs[0]!.run.binding, startedAt: start, endedAt: null, durationMs: null, gap: null });
    });
    close(f.store); const recovered = open(f.file);
    expect(recovered.get(identity)!.segments[0]).toMatchObject({ segmentId: uuid(20), segmentOrdinal: "1", endedAt: null });
    expect(() => recovered.update(recovered.get(identity)!, draft => {
      draft.runs[0]!.run.segmentIds.push(uuid(21)); draft.segments.push({ ...draft.segments[0]!, segmentId: uuid(21) });
    })).toThrow();
    const complete = stopped({ ...f, store: recovered }, recovered.get(identity)!);
    const sealed = recovered.update(complete, draft => { draft.segments[0]!.endedAt = finish; draft.segments[0]!.durationMs = "60000"; });
    expect(sealed.segments[0]!.endedAt).toBe(finish);
    expect(() => recovered.update(sealed, draft => { draft.segments[0]!.durationMs = "61000"; })).toThrow();
  });

  it("refuses corrupted persisted evidence and future schemas without resetting responsibility", () => {
    const f = fixture(); active(f); close(f.store);
    const db = new Database(f.file); db.pragma("user_version = 3"); db.close();
    expect(() => open(f.file)).toThrow();
    const inspect = new Database(f.file); expect(inspect.prepare("SELECT count(*) AS n FROM executions").get()).toEqual({ n: 1 }); inspect.pragma("user_version = 2"); inspect.prepare("UPDATE executions SET data = ?").run('{"broken":true}'); inspect.close();
    expect(() => open(f.file).list()).toThrow();
  });

  it("does not erase stop responsibility when the database version is missing", () => {
    const f = fixture(); active(f); close(f.store);
    const db = new Database(f.file); db.pragma("user_version = 0"); db.close();
    expect(() => open(f.file)).toThrow();
    const inspect = new Database(f.file); expect(inspect.prepare("SELECT count(*) AS n FROM executions").get()).toEqual({ n: 1 }); inspect.close();
  });
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

it("upgrades original lifecycle rows and freezes never-started retirements without inventing run evidence", () => {
  const f = fixture(), original = f.record; close(f.store);
  const old = new Database(f.file); old.exec("DROP TABLE never_started_retirements"); old.pragma("user_version = 1"); old.close();
  const upgraded = open(f.file);
  expect(upgraded.get(identity)).toEqual(original); expect(upgraded.listRetired()).toEqual([]);
  upgraded.retireNeverStarted(original); expect(upgraded.get(identity)).toEqual(original);
  expect(upgraded.listRetired()).toEqual([original]);
  expect(() => upgraded.update(original, draft => { draft.preparation = { instanceId: "later", instanceDirectory: f.directory, phase: "prepared", daemon: null }; })).toThrow(/retired/);
  expect(() => upgraded.create({ owner, claimId: identity.claimId, cwd: f.directory })).toThrow(/retired/);
  close(upgraded); const restarted = open(f.file); expect(restarted.retired(identity)).toEqual(original);
  const corrupt = new Database(f.file); corrupt.prepare("UPDATE never_started_retirements SET version = version + 1").run(); corrupt.close();
  expect(() => restarted.listRetired()).toThrow(/inconsistent/);
});
it("does not retire stale or started lifecycle evidence", () => {
  const f = fixture(), stale = f.record;
  f.store.update(stale, draft => { draft.preparation = { instanceId: "original", instanceDirectory: f.directory, phase: "launch_requested", daemon: null }; });
  expect(() => f.store.retireNeverStarted(stale)).toThrow(/changed/);
  expect(() => f.store.retireNeverStarted(f.store.get(identity)!)).toThrow(/changed/);
  expect(f.store.listRetired()).toEqual([]);
});
