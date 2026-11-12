import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, open } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import * as sqliteAccess from "../../../src/platform/sqlite-access.js";
import { ControllerMetadataBudgetError } from "../../../src/commands/controller/media/metadata-budget.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { replayStoppedControllerHistory, type StoppedSourceTail } from "../../../src/commands/controller/stopped-history.js";
const errorCauses = (error: unknown): Error[] => {
  const values: Error[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) values.push(cause);
  return values;
};
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (count = 3, text = "durable", floor = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/stopped-history-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journalPath = path.join(home, "journal.sqlite"), store = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true, ...(floor ? { maxOutboxBytes: 256 } : {}) });
  for (let i = 0; i < count; i++) store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
  store.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt } }); store.markDispatching(ticket.initialOperationId); store.recordOperation(ticket.initialOperationId, "unknown");
  store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); store.close();
  const read = () => { const db = new Database(journalPath, { readonly: true }); try { return { state: db.prepare("SELECT snapshot,ticket_hash,owner_pid,last_sequence,last_acknowledged,source_floor FROM execution").get(), operation: db.prepare("SELECT value FROM operations").get(), outbox: db.prepare("SELECT count(*) AS total FROM outbox").get(), batch: db.prepare("SELECT value FROM image_runtime_state WHERE key='stopped_source_tail'").get() }; } finally { db.close(); } };
  return { journalPath, ticket, read };
};
const acknowledged = (batch: StoppedSourceTail) => ({ sourceEpoch: batch.sourceEpoch, batchId: batch.batchId, lastAckedSourceSeq: batch.events.at(-1)!.sourceSeq });

test("bounded stopped replay advances exact source ACK without changing native, snapshot or unknown operation identities", async () => {
  const f = await fixture(103), before = f.read(), batches: StoppedSourceTail[] = [];
  await replayStoppedControllerHistory({ ...f, send: async batch => { batches.push(batch); return acknowledged(batch); } });
  const after = f.read();
  expect(batches.map(batch => batch.events.length)).toEqual([100, 3]);
  expect(after.state).toMatchObject({ ...(before.state as object), last_acknowledged: 103 });
  expect(after.operation).toEqual(before.operation); expect(after.outbox).toEqual({ total: 0 }); expect(after.batch).toBeUndefined();
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

test("a stopped batch cannot consume metadata beyond the settlement reserve or discard its original events", async () => {
  const f = await fixture(), before = f.read(), pending = `${f.journalPath}.pending-content`;
  const retained = await open(path.join(pending, "retained.tmp"), "wx", 0o600);
  try { await retained.truncate(136 * 1048576); } finally { await retained.close(); }
  const send = vi.fn();
  const failure = await replayStoppedControllerHistory({ ...f, send }).then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ name: "ControllerStorageWaitingError", reason: "physical_capacity" });
  expect(errorCauses(failure)).toEqual(expect.arrayContaining([expect.any(ControllerMetadataBudgetError)]));
  expect(send).not.toHaveBeenCalled(); expect(f.read()).toEqual(before);
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
