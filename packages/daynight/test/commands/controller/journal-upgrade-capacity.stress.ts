import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { upgradeControllerJournal } from "../../../src/commands/controller/storage-preparation.js";
import { readControllerSnapshot, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { sessionBinding } from "../../../src/session/protocol.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-upgrade-capacity");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "s-")); roots.push(root);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original input", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { root, file: path.join(root, "journal.sqlite"), ticket };
};
const stoppedSnapshot = (ticket: ControllerLaunchTicket) => ({ executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "stopped", activity: "stopped", initialInputState: "confirmed", nativeSessionId: randomUUID(), nativeStopped: true, stoppedAt: new Date().toISOString(), controllerProcess: null, nativeProcesses: [], currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, error: null });
const createV10 = (f: Awaited<ReturnType<typeof fixture>>, snapshot: ReturnType<typeof stoppedSnapshot>, cleanup: 0 | 1, owner: number | null = null, large = false) => {
  const db = new Database(f.file);
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 10)) db.exec(step.sql);
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,legacy_timeline_cleanup_pending) VALUES(1,?,?,?,?)").run(controllerPayloadHash(f.ticket), owner, JSON.stringify(snapshot), cleanup);
    db.pragma("user_version=10");
    if (large) {
      db.prepare("INSERT INTO outbox(sequence,value) VALUES(1,CAST(zeroblob(?) AS TEXT))").run(140 * 1048576);
      db.exec("DELETE FROM outbox");
    }
  } finally { db.close(); }
};

test.each([0, 1] as const)("pure v10 upgrade and state reads ignore a 140 MiB physical journal with cleanup flag %s", async cleanup => {
  const f = await fixture(), snapshot = stoppedSnapshot(f.ticket);
  createV10(f, snapshot, cleanup, null, true);
  expect((await stat(f.file)).size).toBeGreaterThan(139 * 1048576);
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(upgradeControllerJournal(f.file, permit, { onMigration: () => {} })).toEqual({ version: currentSqliteVersion(controllerJournalFormat), legacyTimelineCleanupPending: cleanup === 1 });
    expect(readControllerSnapshot(f.file, permit)).toEqual(snapshot);
    const db = new Database(f.file, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
      expect(db.prepare("SELECT legacy_timeline_cleanup_pending AS pending FROM execution").get()).toEqual({ pending: cleanup });
    } finally { db.close(); }
  } finally { permit.release(); }
}, 30000);

test("pure upgrade ignores an execution above its physical capacity", async () => {
  const f = await fixture(), snapshot = stoppedSnapshot(f.ticket); createV10(f, snapshot, 0);
  const index = `${f.file}.native-index`; await mkdir(index, { mode: 0o700 });
  const file = path.join(index, "retained"); await writeFile(file, ""); await truncate(file, 2_306_867_201);
  expect((await stat(file)).size).toBeGreaterThan(2_306_867_200);
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(upgradeControllerJournal(f.file, permit, { onMigration: () => {} })).toEqual({ version: currentSqliteVersion(controllerJournalFormat), legacyTimelineCleanupPending: false });
    expect(readControllerSnapshot(f.file, permit)).toEqual(snapshot);
  } finally { permit.release(); }
});

test("stop recording upgrades v10 without capacity admission before observing and committing the original state", async () => {
  const f = await fixture(), snapshot = { ...stoppedSnapshot(f.ticket), lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 123, parentPid: 12, processGroupId: process.platform === "win32" ? null : 123, startedAt: "original", commandHash: "a".repeat(64), ...(process.platform === "win32" ? { jobObjectName: `Local\\Daynight-${f.ticket.launchId}` } : {}) } };
  createV10(f, snapshot as unknown as ReturnType<typeof stoppedSnapshot>, 1, null, true);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const stopped = await recordStoppedControllerGeneration(f.file, f.ticket, { ...(process.platform === "win32" ? { jobLease: {} as ControllerJobLease } : {}) });
  expect(stopped).toMatchObject({ executionId: f.ticket.executionId, lifecycle: "stopped", nativeStopped: true });
  expect(readControllerSnapshot(f.file)).toEqual(stopped);
  const db = new Database(f.file, { readonly: true });
  try { expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); } finally { db.close(); }
}, 30000);
