import { renameSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { assignWindowsJobSource, openControllerLifecycleStore, prepareWindowsJobSource, readControllerSnapshot, readWindowsJobReceipt } from "../../../src/commands/controller/lifecycle-store.js";
import { openControllerStop, isControllerStopIdentityConflict } from "../../../src/commands/controller/controller-stop.js";
import * as guardian from "../../../src/commands/controller/windows-job-guardian.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { WindowsJobPreparedSource } from "../../../src/commands/controller/windows-job-evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async (withNative = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-stop-order"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const controller = { pid: 1234, parentPid: 12, processGroupId: null, startedAt: "2026-11-11T00:00:00.1234560Z", commandHash: "a".repeat(64) };
  const prepared: WindowsJobPreparedSource = { version: 1, phase: "prepared", launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket), guardian: { ...controller, pid: 1235, parentPid: controller.pid, commandHash: "b".repeat(64) }, jobHandle: "100", controller };
  const assigned = { ...prepared, phase: "assigned" as const }, file = path.join(home, "journal.sqlite");
  const store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ controllerProcess: { ...controller, jobObjectName: `Local\\Daynight-${ticket.launchId}` } });
  prepareWindowsJobSource(file, ticket, prepared); assignWindowsJobSource(file, ticket, prepared, assigned);
  const native = { ...controller, pid: 1236, parentPid: controller.pid, commandHash: "c".repeat(64) };
  if (withNative) store.patchSnapshot({ nativeProcesses: [native] });
  store.close();
  const lease = { inspect: vi.fn(() => ({ sealed: true, active: 0, members: [] })), terminate: vi.fn(), seal: vi.fn(), sealAndObserveEmpty: vi.fn(() => ({ sealed: true, active: 0, members: [] })), close: vi.fn(), closeAfterCommit: vi.fn() };
  vi.spyOn(guardian, "openWindowsGuardianJob").mockResolvedValue(lease);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  return { file, ticket, controller, native, lease };
};

test.each(["success", "source conflict", "ordinary I/O"] as const)("stop commit settles %s before the coordinator wake", async scenario => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const events: string[] = [];
  let conflict: unknown, microtaskReceipt: unknown;
  let moved = false;
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    const result = stop.commit({
      onVerified: () => {
        events.push("verified");
        if (scenario === "source conflict") {
          const db = new Database(f.file);
          try { db.exec("UPDATE execution SET snapshot=json_set(snapshot,'$.error','changed after verification')"); } finally { db.close(); }
        } else if (scenario === "ordinary I/O") { renameSync(f.file, `${f.file}.moved`); moved = true; }
        queueMicrotask(() => {
          events.push("wake");
          if (scenario === "success") microtaskReceipt = readWindowsJobReceipt(f.file, f.ticket);
        });
      },
      onConflict: error => { events.push("conflict"); conflict = error; },
    });
    if (scenario === "success") {
      await expect(result).resolves.toMatchObject({ lifecycle: "stopped", nativeStopped: true });
      expect(events).toEqual(["verified", "wake"]);
      expect(microtaskReceipt).toMatchObject({ sealed: true, empty: true });
    } else {
      await expect(result).rejects.toThrow();
      expect(events).toEqual(scenario === "source conflict" ? ["verified", "conflict", "wake"] : ["verified", "wake"]);
      if (scenario === "source conflict") expect(isControllerStopIdentityConflict(conflict)).toBe(true);
      else expect(conflict).toBeUndefined();
    }
    if (moved) { renameSync(`${f.file}.moved`, f.file); moved = false; }
    if (scenario !== "success") {
      expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
      if (scenario === "source conflict") expect(readControllerSnapshot(f.file)?.error).toBe("changed after verification");
    }
  } finally {
    if (moved) renameSync(`${f.file}.moved`, f.file);
    Object.defineProperty(process, "platform", platform);
  }
});

test.each(["removed", "changed"] as const)("rejects a native identity %s during asynchronous stop verification", async change => {
  const f = await fixture(true), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  vi.mocked(processProof.inspectProcessProof).mockImplementation(async proof => {
    if (proof.pid === f.native.pid && !blocked) { blocked = true; enter(); await barrier; }
    return "stopped";
  });
  const verified = vi.fn(), conflict = vi.fn();
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [f.native] });
    const result = stop.commit({ onVerified: verified, onConflict: conflict });
    void result.catch(() => {});
    await entered;
    const original = readControllerSnapshot(f.file)!;
    const altered = { ...original, nativeProcesses: change === "removed" ? [] : [{ ...f.native, commandHash: "d".repeat(64) }] };
    const db = new Database(f.file);
    try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify(altered)); } finally { db.close(); }
    release();
    await expect(result).rejects.toThrow();
    expect(verified).not.toHaveBeenCalled();
    expect(conflict).toHaveBeenCalledOnce();
    expect(isControllerStopIdentityConflict(conflict.mock.calls[0]![0])).toBe(true);
    expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
    expect(readControllerSnapshot(f.file)?.nativeProcesses).toEqual(altered.nativeProcesses);
    await stop.close();
  } finally { release(); Object.defineProperty(process, "platform", platform); }
});
