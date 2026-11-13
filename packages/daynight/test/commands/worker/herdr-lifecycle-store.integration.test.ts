import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { herdrLedgerHash, herdrLedgerPayloadHash, readHerdrLifecycleRecords } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import { createHerdrLifecycleStoreFixtures } from "./herdr-lifecycle-store.fixtures.js";

const { uuid, owner, identity, start, finish, open, close, fixture, processIdentity, prepared, active, stopped } = createHerdrLifecycleStoreFixtures("file");

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
    const db = new Database(f.file); db.pragma("user_version = 5"); db.close();
    expect(() => open(f.file)).toThrow();
    const inspect = new Database(f.file); expect(inspect.prepare("SELECT count(*) AS n FROM executions").get()).toEqual({ n: 1 }); inspect.pragma("user_version = 3"); inspect.prepare("UPDATE executions SET data = ?").run('{"broken":true}'); inspect.close();
    expect(() => open(f.file).list()).toThrow();
  });

it("does not erase stop responsibility when the database version is missing", () => {
    const f = fixture(); active(f); close(f.store);
    const db = new Database(f.file); db.pragma("user_version = 0"); db.close();
    expect(() => open(f.file)).toThrow();
    const inspect = new Database(f.file); expect(inspect.prepare("SELECT count(*) AS n FROM executions").get()).toEqual({ n: 1 }); inspect.close();
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

it("migrates an original prepared run but preserves closing launch uncertainty", () => {
    const f = fixture();
    const run = prepared(f.directory); run.daemon = processIdentity("daemon", 101); run.processes = [processIdentity("shell", 102)];
    const record = f.store.update(f.record, draft => { draft.runs.push(run); });
    close(f.store);
    const old = new Database(f.file);
    const legacy = JSON.parse(JSON.stringify(record)); delete legacy.runs[0].nativeLaunch;
    old.prepare("UPDATE executions SET data = ?").run(JSON.stringify(legacy)); old.pragma("user_version = 2"); old.close();
    const upgraded = open(f.file); const original = upgraded.get(identity)!;
    expect(original.runs[0]).toMatchObject({ phase: "prepared", nativeLaunch: "not_submitted" });
    expect(original.runs[0]!.processes).toEqual(record.runs[0]!.processes);
    close(upgraded);
    const unknown = new Database(f.file);
    legacy.runs[0].phase = "stop_unknown";
    unknown.prepare("UPDATE executions SET data = ?").run(JSON.stringify(legacy)); unknown.pragma("user_version = 2"); unknown.close();
    const reopened = open(f.file);
    expect(reopened.get(identity)!.runs[0]).toMatchObject({ phase: "stop_unknown", nativeLaunch: "unknown" });
    expect(() => reopened.update(reopened.get(identity)!, draft => { draft.runs[0]!.nativeLaunch = "not_submitted"; })).toThrow();
  });

it("does not infer never-submitted launch from incomplete legacy prepared evidence", () => {
    const f = fixture();
    const record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); }); close(f.store);
    const old = new Database(f.file), legacy = JSON.parse(JSON.stringify(record)); delete legacy.runs[0].nativeLaunch;
    old.prepare("UPDATE executions SET data = ?").run(JSON.stringify(legacy)); old.pragma("user_version = 2"); old.close();
    const reopened = open(f.file);
    expect(reopened.get(identity)!.runs[0]!.nativeLaunch).toBe("unknown");
    const unknown = reopened.get(identity)!;
    expect(() => reopened.confirmNativeLaunchRejected(unknown, { method: "agent.start", code: "agent_pane_busy", executionGeneration: "1", binding: unknown.runs[0]!.run.binding })).toThrow();
    expect(reopened.get(identity)).toEqual(unknown);
  });

it("does not allow requested launch evidence to become never submitted", () => {
    const f = fixture();
    let record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.nativeLaunch = "requested"; });
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "stop_unknown"; });
    expect(() => f.store.update(record, draft => { draft.runs[0]!.nativeLaunch = "not_submitted"; })).toThrow();
    close(f.store); const restarted = open(f.file);
    expect(restarted.get(identity)!.runs[0]!.nativeLaunch).toBe("requested");
  });

it("commits an exact definite busy rejection without changing its original run or weakening generic rollback", () => {
  const f = fixture();
  let record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
  record = f.store.update(record, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.nativeLaunch = "requested"; });
  const evidence = { method: "agent.start" as const, code: "agent_pane_busy" as const, executionGeneration: "1", binding: record.runs[0]!.run.binding };
  expect(() => f.store.update(record, draft => { draft.runs[0]!.phase = "prepared"; draft.runs[0]!.nativeLaunch = "not_submitted"; })).toThrow();
  const rejected = f.store.confirmNativeLaunchRejected(record, evidence);
  expect(rejected).toEqual({ ...record, version: record.version + 1, runs: [{ ...record.runs[0]!, phase: "prepared", nativeLaunch: "not_submitted" }] });
  close(f.store); const reopened = open(f.file);
  expect(reopened.get(identity)).toEqual(rejected);
  const retry = reopened.update(rejected, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.nativeLaunch = "requested"; });
  expect(retry.runs).toHaveLength(1);
  expect(retry.runs[0]!.run).toEqual(record.runs[0]!.run);
});

it("rejects stale or mismatched busy-rejection evidence without changing the requested run", () => {
  const f = fixture();
  let record = f.store.update(f.record, draft => { draft.runs.push(prepared(f.directory)); });
  record = f.store.update(record, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.nativeLaunch = "requested"; });
  const evidence = { method: "agent.start" as const, code: "agent_pane_busy" as const, executionGeneration: "1", binding: record.runs[0]!.run.binding };
  expect(() => f.store.confirmNativeLaunchRejected(record, { ...evidence, executionGeneration: "2" })).toThrow();
  expect(() => f.store.confirmNativeLaunchRejected(record, { ...evidence, binding: { ...evidence.binding, paneId: "foreign-pane" } })).toThrow();
  expect(() => f.store.confirmNativeLaunchRejected(record, { ...evidence, code: "request_unknown" as never })).toThrow();
  expect(f.store.get(identity)).toEqual(record);
  const changed = f.store.update(record, draft => { draft.controlEpoch = "1"; });
  expect(() => f.store.confirmNativeLaunchRejected(record, evidence)).toThrow(/version|stale/i);
  const unknown = f.store.update(changed, draft => { draft.runs[0]!.phase = "stop_unknown"; });
  expect(() => f.store.confirmNativeLaunchRejected(unknown, evidence)).toThrow();
  expect(f.store.get(identity)).toEqual(unknown);
  const g = fixture(), observed = active(g);
  expect(() => g.store.confirmNativeLaunchRejected(observed, { ...evidence, binding: observed.runs[0]!.run.binding })).toThrow();
  expect(g.store.get(identity)).toEqual(observed);
});

it("migrates legacy stopped and pending ledger identities without rewriting their wire evidence", () => {
  const f = fixture(); let record = active(f);
  record = f.store.update(record, draft => {
    draft.connectionEpoch = "1";
    draft.ledgerRequest = { connectionEpoch: "1", message: { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: draft.sessionId, claimId: draft.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "generation_ledger", payload: { runs: draft.runs.map(run => run.run), finalizationId: null } } };
  });
  record = stopped(f, record); close(f.store);
  const old = new Database(f.file), legacy = JSON.parse(JSON.stringify(record)); delete legacy.runs[0].nativeLaunch;
  old.prepare("UPDATE executions SET data = ?").run(JSON.stringify(legacy)); old.pragma("user_version = 2"); old.close();
  const migrated = open(f.file).get(identity)!;
  expect(migrated.runs[0]!.nativeLaunch).toBe("observed");
  expect(migrated.runs[0]!.run).toEqual(record.runs[0]!.run);
  expect(migrated.ledgerRequest).toEqual(record.ledgerRequest);
  expect(migrated.version).toBe(record.version);
});

it("rejects a legacy migration with unknown fields without changing its original row or format", () => {
  const f = fixture(); const record = active(f); close(f.store);
  const old = new Database(f.file), legacy = JSON.parse(JSON.stringify(record)); delete legacy.runs[0].nativeLaunch;
  legacy.runs[0].unrecognizedLaunchEvidence = true;
  const data = JSON.stringify(legacy);
  old.prepare("UPDATE executions SET data = ?").run(data); old.pragma("user_version = 2"); old.close();
  expect(() => open(f.file)).toThrow();
  const unchanged = new Database(f.file);
  expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
  expect(unchanged.prepare("SELECT data FROM executions").get()).toEqual({ data }); unchanged.close();
});

it("rolls back migration rather than exceeding the bounded lifecycle row format", () => {
  const f = fixture(); const original = stopped(f, active(f)); close(f.store);
  const legacy = JSON.parse(JSON.stringify(original));
  const template = legacy.runs[0]; delete template.nativeLaunch;
  legacy.runs = Array.from({ length: 600 }, (_, index) => {
    const run = structuredClone(template); run.run.executionGeneration = String(index + 1);
    run.stopOperationId = uuid(1000 + index); run.run.stopProof.recordId = run.stopOperationId;
    run.run.stopProof.executionGeneration = run.run.executionGeneration;
    run.error = "x"; return run;
  });
  legacy.initialPrompt = "x";
  const limit = 8 * 1024 * 1024, desired = limit - 8;
  const perRun = Math.floor((desired - Buffer.byteLength(JSON.stringify(legacy))) / legacy.runs.length);
  for (const run of legacy.runs) run.error += "x".repeat(perRun);
  legacy.initialPrompt += "x".repeat(desired - Buffer.byteLength(JSON.stringify(legacy)));
  const data = JSON.stringify(legacy); expect(Buffer.byteLength(data)).toBe(desired);
  const old = new Database(f.file); old.prepare("UPDATE executions SET data = ?").run(data); old.pragma("user_version = 2"); old.close();
  let failure: unknown;
  try { open(f.file); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ kind: "migration-failed", outcome: "rolled-back" });
  expect(((failure as Error).cause as Error).cause).toHaveProperty("message", "Migrated lifecycle metadata exceeds its size limit.");
  const unchanged = new Database(f.file);
  expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
  expect(unchanged.prepare("SELECT data FROM executions").get()).toEqual({ data }); unchanged.close();
});
