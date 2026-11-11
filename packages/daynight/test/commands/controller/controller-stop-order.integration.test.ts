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

test.each(["appended", "removed", "changed"] as const)("Windows stop observation rejects native evidence %s during asynchronous process inspection", async change => {
  const f = await fixture(true), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(processProof.inspectProcessProof).mockImplementation(async proof => {
    if (proof.pid === f.native.pid) { enter(); await barrier; }
    return "stopped";
  });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [f.native] });
    const result = stop.confirm(); void result.catch(() => {});
    await entered;
    const original = readControllerSnapshot(f.file)!;
    const nativeProcesses = change === "removed" ? [] : change === "changed" ? [{ ...f.native, commandHash: "d".repeat(64) }] : [f.native, { ...f.native, pid: f.native.pid + 1 }];
    const db = new Database(f.file);
    try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...original, nativeProcesses })); } finally { db.close(); }
    release();
    await expect(result).rejects.toSatisfy(isControllerStopIdentityConflict);
    expect(readControllerSnapshot(f.file)?.nativeProcesses).toEqual(nativeProcesses);
    expect(readWindowsJobReceipt(f.file, f.ticket)).toBeNull();
    await stop.close();
  } finally { release(); Object.defineProperty(process, "platform", platform); }
});

const posixFixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-stop-posix"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const controller = { pid: 1234, parentPid: 12, processGroupId: 1234, startedAt: "original", commandHash: "a".repeat(64) };
  const native = { ...controller, pid: 1235, parentPid: controller.pid, processGroupId: 1235 };
  const file = path.join(home, "journal.sqlite"), store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ controllerProcess: controller }); store.close();
  return { file, ticket, controller, native };
};

test.each(["success", "source conflict", "ordinary I/O"] as const)("POSIX stop commit settles %s before the coordinator wake", async scenario => {
  const f = await posixFixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const events: string[] = []; let conflict: unknown, moved = false;
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    const result = stop.commit({
      onVerified: () => {
        events.push("verified");
        if (scenario === "source conflict") {
          const current = readControllerSnapshot(f.file)!;
          const db = new Database(f.file);
          try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...current, nativeProcesses: [f.native] })); } finally { db.close(); }
        } else if (scenario === "ordinary I/O") { renameSync(f.file, `${f.file}.moved`); moved = true; }
        queueMicrotask(() => events.push("wake"));
      },
      onConflict: error => { events.push("conflict"); conflict = error; },
    });
    if (scenario === "success") await expect(result).resolves.toMatchObject({ lifecycle: "stopped", nativeStopped: true });
    else await expect(result).rejects.toThrow();
    expect(events).toEqual(scenario === "source conflict" ? ["verified", "conflict", "wake"] : ["verified", "wake"]);
    if (scenario === "source conflict") expect(isControllerStopIdentityConflict(conflict)).toBe(true);
    else expect(conflict).toBeUndefined();
    if (moved) { renameSync(`${f.file}.moved`, f.file); moved = false; }
    if (scenario === "source conflict") expect(readControllerSnapshot(f.file)?.nativeProcesses).toEqual([f.native]);
  } finally { if (moved) renameSync(`${f.file}.moved`, f.file); Object.defineProperty(process, "platform", platform); }
});

test("POSIX stop checks newly captured native evidence and rejects changes during the asynchronous check", async () => {
  const f = await posixFixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockImplementation(async () => { enter(); await barrier; return true; });
  const verified = vi.fn(), conflict = vi.fn();
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    const result = stop.commit({ onVerified: verified, onConflict: conflict }); void result.catch(() => {});
    await entered;
    const snapshot = readControllerSnapshot(f.file)!, db = new Database(f.file);
    try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...snapshot, nativeProcesses: [f.native] })); } finally { db.close(); }
    release();
    await expect(result).rejects.toThrow("source changed");
    expect(confirm).toHaveBeenCalledWith(f.controller, []);
    expect(verified).toHaveBeenCalledOnce(); expect(conflict).toHaveBeenCalledOnce();
    expect(isControllerStopIdentityConflict(conflict.mock.calls[0]![0])).toBe(true);
    expect(readControllerSnapshot(f.file)?.nativeProcesses).toEqual([f.native]);
  } finally { release(); Object.defineProperty(process, "platform", platform); }
});

test("POSIX commit confirms native evidence captured after the initial observation", async () => {
  const f = await posixFixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(false);
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    const snapshot = readControllerSnapshot(f.file)!, db = new Database(f.file);
    try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...snapshot, nativeProcesses: [f.native] })); } finally { db.close(); }
    const verified = vi.fn(); await expect(stop.commit({ onVerified: verified, onConflict: vi.fn() })).rejects.toThrow("still running");
    expect(confirm).toHaveBeenCalledWith(f.controller, [f.native]); expect(verified).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("POSIX observation requires the journal and limits pre-hello proof to a compatible startup", async () => {
  const f = await posixFixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  let moved = false;
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    renameSync(f.file, `${f.file}.moved`); moved = true;
    await expect(stop.confirm()).rejects.toThrow("unavailable");
    renameSync(`${f.file}.moved`, f.file); moved = false;
    const snapshot = readControllerSnapshot(f.file)!, db = new Database(f.file);
    try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...snapshot, controllerProcess: null })); } finally { db.close(); }
    await expect(stop.confirm()).resolves.toBe(true);
    const verified = vi.fn(); await expect(stop.commit({ onVerified: verified, onConflict: vi.fn() })).rejects.toThrow("unavailable");
    expect(verified).not.toHaveBeenCalled();
    const changed = new Database(f.file);
    try { changed.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...snapshot, controllerProcess: null, nativeProcesses: [f.native] })); } finally { changed.close(); }
    await expect(stop.confirm()).rejects.toSatisfy(isControllerStopIdentityConflict);
  } finally { if (moved) renameSync(`${f.file}.moved`, f.file); Object.defineProperty(process, "platform", platform); }
});

test.each(["posix", "windows"] as const)("%s stop observation rejects a changed original ticket hash during process inspection", async platformKind => {
  const f = platformKind === "posix" ? await posixFixture() : await fixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: platformKind === "windows" ? "win32" : "linux" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  if (platformKind === "windows") vi.mocked(processProof.inspectProcessProof).mockImplementation(async () => { enter(); await barrier; return "stopped"; });
  else vi.spyOn(processProof, "confirmControllerProcessesStopped").mockImplementation(async () => { enter(); await barrier; return true; });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [] });
    const before = readControllerSnapshot(f.file);
    const result = stop.confirm(); void result.catch(() => {});
    await entered;
    const db = new Database(f.file);
    try { db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("f".repeat(64)); } finally { db.close(); }
    release();
    await expect(result).rejects.toSatisfy(isControllerStopIdentityConflict);
    expect(readControllerSnapshot(f.file)).toEqual(before);
    await stop.close();
  } finally { release(); Object.defineProperty(process, "platform", platform); }
});
