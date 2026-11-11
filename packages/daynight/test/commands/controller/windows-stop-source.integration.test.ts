import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { assignWindowsJobSource, commitWindowsJobStop, openControllerLifecycleStore, prepareWindowsJobSource, readControllerSnapshot, readWindowsJobReceipt } from "../../../src/commands/controller/lifecycle-store.js";
import { isControllerStopIdentityConflict, openControllerStop } from "../../../src/commands/controller/controller-stop.js";
import * as guardian from "../../../src/commands/controller/windows-job-guardian.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { WindowsJobPreparedSource } from "../../../src/commands/controller/windows-job-evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async (committed = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/windows-stop-source"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const controller = { pid: 1234, parentPid: 12, processGroupId: null, startedAt: "2026-11-11T00:00:00.1234560Z", commandHash: "a".repeat(64) };
  const prepared: WindowsJobPreparedSource = { version: 1, phase: "prepared", launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket), guardian: { ...controller, pid: 1235, parentPid: controller.pid, commandHash: "b".repeat(64) }, jobHandle: "100", controller };
  const assigned = { ...prepared, phase: "assigned" as const }, file = path.join(home, "journal.sqlite");
  const store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ controllerProcess: { ...controller, jobObjectName: `Local\\Daynight-${ticket.launchId}` } });
  prepareWindowsJobSource(file, ticket, prepared); assignWindowsJobSource(file, ticket, prepared, assigned); store.close();
  if (committed) commitWindowsJobStop(file, ticket, readControllerSnapshot(file)!, assigned);
  const lease = { inspect: vi.fn(() => ({ sealed: true, active: 0, members: [] })), terminate: vi.fn(), seal: vi.fn(), sealAndObserveEmpty: vi.fn(() => ({ sealed: true, active: 0, members: [] })), close: vi.fn(), closeAfterCommit: vi.fn() };
  vi.spyOn(guardian, "openWindowsGuardianJob").mockResolvedValue(lease);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  return { file, ticket, controller, assigned, lease };
};

test.each(["replaced", "missing"] as const)("Windows stop observation treats the original source %s during process inspection conservatively", async change => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(processProof.inspectProcessProof).mockImplementation(async () => { enter(); await barrier; return "stopped"; });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    const result = stop.confirm(); void result.catch(() => {});
    await entered;
    const db = new Database(f.file);
    try {
      if (change === "missing") db.prepare("DELETE FROM windows_job_evidence WHERE launch_id=?").run(f.ticket.launchId);
      else db.prepare("UPDATE windows_job_evidence SET source=? WHERE launch_id=?").run(JSON.stringify({ ...f.assigned, jobHandle: "101" }), f.ticket.launchId);
    } finally { db.close(); }
    release();
    let failure: unknown;
    try { await result; throw new Error("Changed source was incorrectly accepted as stopped."); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(isControllerStopIdentityConflict(failure)).toBe(change === "replaced");
    if (failure instanceof Error) expect(failure.message).toMatch(change === "replaced" ? /source changed/ : /source is unavailable/);
    expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
    await stop.close();
  } finally { release(); Object.defineProperty(process, "platform", platform); }
});

test.each(["source replaced", "source missing", "receipt replaced", "receipt missing"] as const)("an opened stop receipt refuses a %s", async change => {
  const f = await fixture(true), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    expect(await stop.confirm()).toBe(true);
    const db = new Database(f.file);
    try {
      if (change === "source missing") db.prepare("DELETE FROM windows_job_evidence WHERE launch_id=?").run(f.ticket.launchId);
      else if (change === "source replaced") db.prepare("UPDATE windows_job_evidence SET source=? WHERE launch_id=?").run(JSON.stringify({ ...f.assigned, jobHandle: "101" }), f.ticket.launchId);
      else if (change === "receipt missing") db.prepare("UPDATE windows_job_evidence SET receipt=NULL WHERE launch_id=?").run(f.ticket.launchId);
      else {
        const row = db.prepare("SELECT receipt FROM windows_job_evidence WHERE launch_id=?").get(f.ticket.launchId) as { receipt: string };
        const receipt = JSON.parse(row.receipt); receipt.source.jobHandle = "101";
        db.prepare("UPDATE windows_job_evidence SET receipt=? WHERE launch_id=?").run(JSON.stringify(receipt), f.ticket.launchId);
      }
    } finally { db.close(); }
    await expect(stop.confirm()).rejects.toThrow();
    const verified = vi.fn();
    await expect(stop.commit({ onVerified: verified, onConflict: vi.fn() })).rejects.toThrow();
    expect(verified).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); }
});
