import { parseSourceEvent } from "../../../src/session/controller-protocol.js";
import { ArchiveRequestError } from "../../../src/commands/controller/archive-error.js";
import { sqliteDisplayFilename } from "../../../src/platform/sqlite-filename.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, open } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import * as sqliteAccess from "../../../src/platform/sqlite-access.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { replayStoppedControllerHistory, type StoppedSourceRecovery, type StoppedSourceTail } from "../../../src/commands/controller/stopped-history.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixturePlatforms = process.platform === "win32" ? ["host"] : ["host", "win32"];
const selectFixturePlatform = (value: string): void => { if (value === "win32") Object.defineProperty(process, "platform", { ...platform, value: "win32" }); };
const completeFixtureStop = async (journalPath: string, ticket: ControllerLaunchTicket): Promise<void> => {
  if (process.platform !== "win32") return;
  const db = new Database(journalPath);
  try {
    const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot);
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...snapshot, lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } }));
  } finally { db.close(); }
  const jobLease = {} as ControllerJobLease;
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  try {
    const stopped = await recordStoppedControllerGeneration(journalPath, ticket, { jobLease });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(stopped.controllerProcess, stopped.nativeProcesses, undefined, jobLease);
    expect(stopped.windowsJobStopProof).toMatchObject({ version: 1 });
  } finally { confirm.mockRestore(); }
};
const fixture = async (count = 3, text = "durable", floor = false, beforeStop?: (store: ReturnType<typeof openControllerLifecycleStore>) => void, raw = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/stopped-history-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalPath = path.join(home, "journal.sqlite"), store = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true, ...(floor ? { maxOutboxBytes: 256 } : {}) });
  for (let i = 0; i < count; i++) {
    const entry = { entryId: randomUUID(), revision: "1", kind: "assistant_message" as const, content: [{ type: "text" as const, text }] };
    if (raw) store.appendEvent({ kind: "timeline_upsert", payload: entry }); else store.projectTimeline(entry);
  }
  beforeStop?.(store);
  store.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt } }); store.markDispatching(ticket.initialOperationId); store.recordOperation(ticket.initialOperationId, "unknown");
  store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); store.close();
  await completeFixtureStop(journalPath, ticket);
  const read = () => { const db = new Database(journalPath, { readonly: true }); try { return { state: db.prepare("SELECT snapshot,ticket_hash,owner_pid,last_sequence,last_acknowledged,source_floor FROM execution").get(), operation: db.prepare("SELECT value FROM operations").get(), outbox: db.prepare("SELECT count(*) AS total FROM outbox").get(), batch: db.prepare("SELECT value FROM image_runtime_state WHERE key='stopped_source_tail'").get() }; } finally { db.close(); } };
  return { journalPath, ticket, read };
};
const acknowledged = (batch: StoppedSourceTail) => ({ sourceEpoch: batch.sourceEpoch, batchId: batch.batchId, lastAckedSourceSeq: batch.events.at(-1)!.sourceSeq });

test.each(fixturePlatforms)("bounded stopped replay advances exact source ACK without changing native, snapshot or unknown operation identities (%s)", async fixturePlatform => {
  selectFixturePlatform(fixturePlatform);
  const f = await fixture(103), before = f.read(), batches: StoppedSourceTail[] = [];
  await replayStoppedControllerHistory({ ...f, send: async batch => { batches.push(batch); return acknowledged(batch); } });
  const after = f.read();
  expect(batches.map(batch => batch.events.length)).toEqual([100, 3]);
  expect(after.state).toMatchObject({ ...(before.state as object), last_acknowledged: 103 });
  expect(after.operation).toEqual(before.operation); expect(after.outbox).toEqual({ total: 0 }); expect(after.batch).toBeUndefined();
});

test("stopped replay on another connection accounts for the deleted prefix and complete ACK", async () => {
  const f = await fixture(101, "中文 🐈\n\\\"");
  const account = () => {
    const db = new Database(f.journalPath, { readonly: true });
    try {
      const values = db.prepare("SELECT value FROM outbox ORDER BY sequence").all() as { value: string }[];
      const total = (db.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get() as { byte_length: number }).byte_length;
      expect(total).toBe(values.reduce((sum, row) => sum + Buffer.byteLength(row.value, "utf8"), 0));
      return values.length;
    } finally { db.close(); }
  };
  const observed: number[] = [];
  await replayStoppedControllerHistory({ ...f, send: async batch => { observed.push(account()); return acknowledged(batch); } });
  expect(observed).toEqual([101, 1]);
  expect(account()).toBe(0);
});

test("stopped ACK reports its actual rollback and retains the original batch on accounting corruption", async () => {
  const f = await fixture(101); let sent!: StoppedSourceTail;
  const failure = await replayStoppedControllerHistory({ ...f, send: async batch => {
    sent = batch;
    const db = new Database(f.journalPath);
    try { db.prepare("UPDATE outbox_totals SET byte_length=1 WHERE id=1").run(); } finally { db.close(); }
    return acknowledged(batch);
  } }).then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ kind: "invalid-format", context: { phase: "outbox-ack" }, outcome: "rolled-back", connectionClosed: true, cause: { kind: "invalid-format", outcome: "rolled-back", cause: { kind: "invalid-format", outcome: "unknown" } } });
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 });
  expect(f.read().outbox).toEqual({ total: 101 });
  expect(f.read().batch).toEqual({ value: JSON.stringify(sent) });
});

test("a failed stopped ACK rollback retains both errors and does not invent an outcome", async () => {
  const f = await fixture(101), exec = Database.prototype.exec, rollbackFailure = new Error("injected rollback failure");
  const failure = await replayStoppedControllerHistory({ ...f, send: async batch => {
    const db = new Database(f.journalPath);
    try { db.prepare("UPDATE outbox_totals SET byte_length=1 WHERE id=1").run(); } finally { db.close(); }
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sqliteDisplayFilename(this.name) === f.journalPath && sql === "ROLLBACK") throw rollbackFailure;
      return exec.call(this, sql);
    });
    return acknowledged(batch);
  } }).then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ kind: "operation-failed", outcome: "unknown", connectionClosed: true });
  const errors = ((failure as Error).cause as AggregateError).errors;
  expect(errors[0]).toMatchObject({ kind: "invalid-format", context: { phase: "outbox-ack" }, outcome: "unknown" });
  expect(errors[1]).toBe(rollbackFailure);
  expect(sqliteAccess.sqliteTransactionOutcome((failure as Error).cause)).toBe("unknown");
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 });
  expect(f.read().outbox).toEqual({ total: 101 });
});

test("unknown HTTP results retain exact durable batch ID and bytes across a new replay invocation", async () => {
  const f = await fixture(); let original!: StoppedSourceTail;
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => { original = batch; throw new Error("Response lost after commit"); } })).rejects.toThrow("Response lost");
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().batch).toEqual({ value: JSON.stringify(original) });
  await replayStoppedControllerHistory({ ...f, send: async batch => { expect(JSON.stringify(batch)).toBe(JSON.stringify(original)); return acknowledged(batch); } });
  expect(f.read().state).toMatchObject({ last_acknowledged: 3 });
});

test.each(["epoch", "batch", "cutoff", "extra"])("a mismatched %s ACK cannot delete the original source tail", async field => {
  const f = await fixture();
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => ({ ...acknowledged(batch), ...(field === "epoch" ? { sourceEpoch: randomUUID() } : field === "batch" ? { batchId: randomUUID() } : field === "cutoff" ? { lastAckedSourceSeq: "2" } : { extra: true }) }) })).rejects.toThrow("acknowledgement");
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 3 });
});

test("a discarded source prefix cannot be invented from the complete local timeline", async () => {
  const f = await fixture(4, "x".repeat(200), true), send = vi.fn();
  await expect(replayStoppedControllerHistory({ ...f, send })).rejects.toThrow("source floor");
  expect(send).not.toHaveBeenCalled(); expect(f.read().state).toMatchObject({ last_acknowledged: 0 });
});

test("the stopped source cutoff is rechecked after asynchronous transport before persisting its ACK", async () => {
  const f = await fixture();
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => { const db = new Database(f.journalPath); try { db.exec("UPDATE execution SET last_sequence=last_sequence+1"); } finally { db.close(); } return acknowledged(batch); } })).rejects.toThrow("source cutoff changed");
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 3 });
});

test("valid one MiB text events use separate bounded batches without changing their text", async () => {
  const text = "x".repeat(1048576), f = await fixture(2, text), batches: StoppedSourceTail[] = [];
  await replayStoppedControllerHistory({ ...f, send: async batch => { batches.push(batch); const event = batch.events[0]!; expect(event.kind).toBe("timeline_upsert"); if (event.kind === "timeline_upsert" && event.payload.kind === "assistant_message") expect(event.payload.content).toEqual([{ type: "text", text }]); return acknowledged(batch); } });
  expect(batches.map(batch => batch.events.length)).toEqual([1, 1]);
});

test("an active generation is rejected before transport", async () => {
  const f = await fixture(), db = new Database(f.journalPath); try { db.exec("UPDATE execution SET snapshot=json_set(snapshot,'$.nativeStopped',json('false'),'$.lifecycle','ready')"); } finally { db.close(); }
  const send = vi.fn(); await expect(replayStoppedControllerHistory({ ...f, send })).rejects.toThrow("original stopped"); expect(send).not.toHaveBeenCalled();
});

test("stopped tail settlement above the former metadata limit preserves the original batch across response loss and ACK", async () => {
  const f = await fixture(1), before = f.read();
  const retained = await open(path.join(`${f.journalPath}.pending-content`, "retained.tmp"), "wx", 0o600);
  try { await retained.truncate(137 * 1048576); } finally { await retained.close(); }
  let original!: StoppedSourceTail;
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => {
    original = batch;
    throw new Error("Response lost after settlement");
  } })).rejects.toThrow("Response lost after settlement");
  expect(f.read().state).toEqual(before.state);
  expect(f.read().outbox).toEqual({ total: 1 });
  expect(f.read().batch).toEqual({ value: JSON.stringify(original) });
  await replayStoppedControllerHistory({ ...f, send: async batch => {
    expect(JSON.stringify(batch)).toBe(JSON.stringify(original));
    return acknowledged(batch);
  } });
  const after = f.read();
  expect(after.state).toEqual({ ...(before.state as object), last_acknowledged: 1 });
  expect(after.operation).toEqual(before.operation);
  expect(after.outbox).toEqual({ total: 0 });
  expect(after.batch).toBeUndefined();
});

test("stopped transport releases local storage ownership before sending and reacquires it before ACK", async () => {
  const f = await fixture();
  let competing: ReturnType<typeof acquireControllerStoragePermit> | undefined;
  try {
    await expect(replayStoppedControllerHistory({ ...f, send: async batch => {
      competing = acquireControllerStoragePermit(f.journalPath);
      expect(f.read().batch).toEqual({ value: JSON.stringify(batch) });
      return acknowledged(batch);
    } })).rejects.toThrow("Cannot acquire instance lock");
    expect(f.read().state).toMatchObject({ last_acknowledged: 0 });
    expect(f.read().outbox).toEqual({ total: 3 });
  } finally { competing?.release(); }
  await replayStoppedControllerHistory({ ...f, send: async batch => acknowledged(batch) });
  expect(f.read().state).toMatchObject({ last_acknowledged: 3 });
});


test("a batch committed before connection shutdown failure retains its committed outcome and durable identity", async () => {
  const f = await fixture(), send = vi.fn();
  const close = sqliteAccess.closeSqliteDatabase;
  const failure = new Error("Injected shutdown report failure");
  vi.spyOn(sqliteAccess, "closeSqliteDatabase").mockImplementation((db, options, outcome) => {
    close(db, options, outcome);
    if (options.file === f.journalPath && outcome === "committed" && f.read().batch !== undefined) throw failure;
  });
  await expect(replayStoppedControllerHistory({ ...f, send })).rejects.toMatchObject({ kind: "cleanup-failed", outcome: "committed", connectionClosed: true, cause: failure });
  expect(send).not.toHaveBeenCalled();
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 });
  expect(f.read().batch).toEqual({ value: expect.any(String) });
  const permit = acquireControllerStoragePermit(f.journalPath);
  permit.release();
});

const legacyPending = async (f: Awaited<ReturnType<typeof fixture>>): Promise<StoppedSourceTail> => {
  let original!: StoppedSourceTail;
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => { original = batch; throw new Error("lost"); } })).rejects.toThrow("lost");
  const legacy = { ...original, events: original.events.map(parseSourceEvent) };
  expect(JSON.stringify(legacy)).not.toBe(JSON.stringify(original));
  const db = new Database(f.journalPath);
  try { db.prepare("UPDATE image_runtime_state SET value=? WHERE key='stopped_source_tail'").run(JSON.stringify(legacy)); } finally { db.close(); }
  return legacy;
};
const conflictError = () => new ArchiveRequestError(409, "session_conflict");

test("legacy wire reorder replays the original before recovery and reconciles the identical recovery after a lost response", async () => {
  const f = await fixture(), legacy = await legacyPending(f); let sentRecovery!: StoppedSourceRecovery;
  await expect(replayStoppedControllerHistory({ ...f,
    send: async batch => { expect(batch).toEqual(legacy); throw conflictError(); },
    recover: async batch => { sentRecovery = batch; throw new Error("lost recovery receipt"); },
  })).rejects.toThrow("lost recovery receipt");
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 3 });
  await replayStoppedControllerHistory({ ...f,
    send: async () => { throw new Error("must reconcile recovery first"); },
    recover: async batch => { expect(batch).toEqual(sentRecovery); return { sourceEpoch: batch.sourceEpoch, recoveryId: batch.recoveryId, verifiedThrough: batch.events.at(-1)!.sourceSeq, currentThrough: "3" }; },
  });
  expect(f.read().state).toMatchObject({ last_acknowledged: 3 }); expect(f.read().outbox).toEqual({ total: 0 });
});

test("a concurrent original batch settles both states only after its exact receipt", async () => {
  const f = await fixture(), legacy = await legacyPending(f); let calls = 0;
  await replayStoppedControllerHistory({ ...f,
    send: async batch => {
      expect(batch).toEqual(legacy);
      if (++calls === 1) throw conflictError();
      const db = new Database(f.journalPath, { readonly: true });
      try { expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='stopped_source_recovery'").get()).toBeDefined(); } finally { db.close(); }
      return acknowledged(batch);
    },
    recover: async () => { throw conflictError(); },
  });
  expect(calls).toBe(2); expect(f.read().outbox).toEqual({ total: 0 });
  const db = new Database(f.journalPath, { readonly: true });
  try { expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='stopped_source_recovery'").get()).toBeUndefined(); } finally { db.close(); }
});

test("an ahead checkpoint settles only the verified original batch", async () => {
  const f = await fixture(101); let calls = 0;
  await replayStoppedControllerHistory({ ...f, send: async batch => {
    calls++;
    if (calls === 2) { expect(f.read().state).toMatchObject({ last_acknowledged: 100 }); expect(f.read().outbox).toEqual({ total: 1 }); }
    return { ...acknowledged(batch), lastAckedSourceSeq: "101" };
  } });
  expect(calls).toBe(2); expect(f.read().state).toMatchObject({ last_acknowledged: 101 });
});

test("a recovery checkpoint beyond cutoff keeps the original pending and all source events", async () => {
  const f = await fixture(); await legacyPending(f);
  await expect(replayStoppedControllerHistory({ ...f, send: async () => { throw conflictError(); }, recover: async batch => ({ sourceEpoch: batch.sourceEpoch, recoveryId: batch.recoveryId, verifiedThrough: batch.events.at(-1)!.sourceSeq, currentThrough: "4" }) })).rejects.toThrow("acknowledgement");
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 3 }); expect(f.read().batch).toBeDefined();
});

test("non-conflict original failure never starts recovery", async () => {
  const f = await fixture(); await legacyPending(f); const recover = vi.fn();
  await expect(replayStoppedControllerHistory({ ...f, send: async () => { throw new ArchiveRequestError(503, "unavailable"); }, recover })).rejects.toMatchObject({ status: 503 });
  expect(recover).not.toHaveBeenCalled(); expect(f.read().outbox).toEqual({ total: 3 });
});

test("legacy recovery persists each bounded prefix and keeps the full outbox across restart", async () => {
  const f = await fixture(2, "x".repeat(1_048_180)); const legacy = await legacyPending(f);
  expect(legacy.events).toHaveLength(2);
  let second!: StoppedSourceRecovery, calls = 0;
  await expect(replayStoppedControllerHistory({ ...f, send: async () => { throw conflictError(); }, recover: async batch => {
    calls++; expect(batch.events).toHaveLength(1);
    expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 2 });
    if (calls === 2) { second = batch; throw new Error("lost second receipt"); }
    return { sourceEpoch: batch.sourceEpoch, recoveryId: batch.recoveryId, verifiedThrough: batch.events.at(-1)!.sourceSeq, currentThrough: "2" };
  } })).rejects.toThrow("lost second receipt");
  await replayStoppedControllerHistory({ ...f, send: async () => { throw new Error("must not switch back to old batch"); }, recover: async batch => {
    expect(batch).toEqual(second); expect(f.read().outbox).toEqual({ total: 2 });
    return { sourceEpoch: batch.sourceEpoch, recoveryId: batch.recoveryId, verifiedThrough: batch.events.at(-1)!.sourceSeq, currentThrough: "2" };
  } });
  expect(f.read().state).toMatchObject({ last_acknowledged: 2 }); expect(f.read().outbox).toEqual({ total: 0 });
});

test("a tracked, never-sent tail can replay its original outbox against an older service", async () => {
  const text = "\u2028".repeat(300_000), f = await fixture(1, text, false, undefined, true);
  await replayStoppedControllerHistory({ ...f, send: async batch => {
    const event = batch.events[0]!;
    expect(event.kind).toBe("timeline_upsert");
    expect(event).toMatchObject({ kind: "timeline_upsert", payload: { kind: "assistant_message", content: [{ type: "text", text }] } });
    return acknowledged(batch);
  } });
  expect(f.read().state).toMatchObject({ last_acknowledged: 1 });
});

test("a frozen live display projection is used again by stopped replay", async () => {
  const text = "\u2028".repeat(300_000); let live!: import("../../../src/session/controller-protocol.js").SourceEvent;
  const f = await fixture(1, text, false, store => {
    const row = store.pendingEvents(1)[0]!;
    live = store.bindSourceWire({ ...(row.payload as object), sourceSeq: row.sequence } as import("../../../src/session/controller-protocol.js").SourceEvent, true);
    expect(live).toMatchObject({ kind: "timeline_upsert", payload: { kind: "error", code: "display_budget_exceeded" } });
  }, true);
  await replayStoppedControllerHistory({ ...f, send: async batch => { expect(batch.events[0]).toEqual(live); return acknowledged(batch); } });
  expect(f.read().outbox).toEqual({ total: 0 });
});

test("old projection without proof replays the old batch but cannot start recovery", async () => {
  const f = await fixture(1, "\u2028".repeat(300_000), false, undefined, true), legacy = await legacyPending(f);
  const db = new Database(f.journalPath); try { db.prepare("DELETE FROM image_runtime_state WHERE key='source_wire_tracking'").run(); } finally { db.close(); }
  const recover = vi.fn();
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => { expect(batch).toEqual(legacy); throw conflictError(); }, recover })).rejects.toMatchObject({ status: 409, code: "session_conflict" });
  expect(recover).not.toHaveBeenCalled(); expect(f.read().outbox).toEqual({ total: 1 }); expect(f.read().batch).toBeDefined();
});

test("a late original receipt cannot clear a batch already settled by recovery", async () => {
  const f = await fixture(), legacy = await legacyPending(f);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const late = replayStoppedControllerHistory({ ...f, send: async batch => { expect(batch).toEqual(legacy); entered(); await waiting; return acknowledged(batch); } });
  await started;
  await replayStoppedControllerHistory({ ...f, send: async () => { throw conflictError(); }, recover: async batch => ({ sourceEpoch: batch.sourceEpoch, recoveryId: batch.recoveryId, verifiedThrough: batch.events.at(-1)!.sourceSeq, currentThrough: "3" }) });
  release();
  await expect(late).rejects.toThrow("batch changed");
  expect(f.read().state).toMatchObject({ last_acknowledged: 3 }); expect(f.read().outbox).toEqual({ total: 0 });
});

test("an unavailable old Server retains and reuses the same recovery request without inferring its outcome", async () => {
  const f = await fixture(), legacy = await legacyPending(f); let saved!: StoppedSourceRecovery;
  const unavailable = new ArchiveRequestError(404, "not_found");
  await expect(replayStoppedControllerHistory({ ...f, send: async batch => { expect(batch).toEqual(legacy); throw conflictError(); }, recover: async batch => { saved = batch; throw unavailable; } })).rejects.toBe(unavailable);
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 3 }); expect(f.read().batch).toEqual({ value: JSON.stringify(legacy) });
  await expect(replayStoppedControllerHistory({ ...f, send: async () => { throw new Error("must reconcile recovery first"); }, recover: async batch => { expect(batch).toEqual(saved); throw unavailable; } })).rejects.toBe(unavailable);
  expect(f.read().state).toMatchObject({ last_acknowledged: 0 }); expect(f.read().outbox).toEqual({ total: 3 });
});
