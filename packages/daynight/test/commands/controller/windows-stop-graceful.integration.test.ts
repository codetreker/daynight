import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { assignWindowsJobSource, openControllerLifecycleStore, prepareWindowsJobSource } from "../../../src/commands/controller/lifecycle-store.js";
import { openControllerStop } from "../../../src/commands/controller/controller-stop.js";
import * as guardian from "../../../src/commands/controller/windows-job-guardian.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { WindowsControllerGuardianKernel } from "../../../src/platform/windows-controller-guardian.js";
import type { WindowsJobPreparedSource } from "../../../src/commands/controller/windows-job-evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/windows-stop-graceful"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const controller = { pid: 1234, parentPid: 12, processGroupId: null, startedAt: "2023-11-14T22:13:20.0000000Z", commandHash: "a".repeat(64) };
  const child = { ...controller, pid: 1236, parentPid: controller.pid, commandHash: "c".repeat(64) };
  const guardianProof = { ...controller, pid: 1235, parentPid: controller.pid, commandHash: "b".repeat(64) };
  const prepared: WindowsJobPreparedSource = { version: 1, phase: "prepared", launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket), guardian: guardianProof, jobHandle: "100", controller };
  const assigned = { ...prepared, phase: "assigned" as const }, file = path.join(home, "journal.sqlite");
  const store = openControllerLifecycleStore(file, ticket);
  store.patchSnapshot({ controllerProcess: { ...controller, jobObjectName: `Local\\Daynight-${ticket.launchId}` } });
  prepareWindowsJobSource(file, ticket, prepared); assignWindowsJobSource(file, ticket, prepared, assigned); store.patchSnapshot({ nativeProcesses: [child] }); store.close();
  const state = { sealed: false, active: 2, members: [controller.pid, child.pid], controllerStopped: false, childStopped: false };
  const guardianHandle = {}, jobHandle = {}, trace: string[] = [];
  const birth = 116444736000000000n + 17000000000000000n;
  const kernel = {
    openGuardian: vi.fn(() => guardianHandle), signaled: vi.fn(() => false),
    identity: vi.fn(() => ({ pid: guardianProof.pid, parentPid: guardianProof.parentPid, birth })),
    captureProof: vi.fn(async () => guardianProof), duplicateJob: vi.fn(() => jobHandle),
    hasKillOnClose: vi.fn(() => true), isSealed: vi.fn(() => state.sealed), active: vi.fn(() => state.active), inspect: vi.fn(() => state.members),
    sealAdmissions: vi.fn(() => { trace.push("seal"); state.sealed = true; }),
    terminate: vi.fn(() => { trace.push("terminate"); state.active = 0; state.members = []; state.controllerStopped = true; state.childStopped = true; }),
    sameJob: vi.fn(() => true), close: vi.fn(), closeProcess: vi.fn(),
  } as unknown as WindowsControllerGuardianKernel;
  const open = guardian.openWindowsGuardianJob;
  vi.spyOn(guardian, "openWindowsGuardianJob").mockImplementation(source => open(source, kernel));
  vi.spyOn(processProof, "inspectProcessProof").mockImplementation(async proof => (proof.pid === controller.pid ? state.controllerStopped : state.childStopped) ? "stopped" : "running");
  return { file, ticket, controller, child, state, kernel, trace, jobHandle };
};

test("graceful stop waits for a sealed empty Job and every original process", async () => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [f.child] });
    f.state.sealed = true; f.state.active = 0; f.state.members = [];
    vi.useFakeTimers();
    let completed = false;
    const result = stop.stop(Date.now() + 5000, { graceful: true }).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toBe(false);
    f.state.controllerStopped = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toBe(false);
    f.state.childStopped = true;
    await vi.advanceTimersByTimeAsync(25); await result;
    expect(completed).toBe(true); expect(f.trace).toEqual([]);
    await stop.close();
  } finally { vi.useRealTimers(); Object.defineProperty(process, "platform", platform); }
});

test("graceful stop seals and terminates the held original Job after its bounded wait", async () => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [f.child] });
    vi.useFakeTimers();
    const result = stop.stop(Date.now() + 5000, { graceful: true });
    await vi.advanceTimersByTimeAsync(1999); expect(f.trace).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await result;
    expect(f.trace).toEqual(["seal", "terminate"]);
    expect(f.kernel.sealAdmissions).toHaveBeenCalledExactlyOnceWith(f.jobHandle); expect(f.kernel.terminate).toHaveBeenCalledExactlyOnceWith(f.jobHandle);
    await stop.close();
  } finally { vi.useRealTimers(); Object.defineProperty(process, "platform", platform); }
});

test("default stop immediately seals and terminates the held original Job", async () => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const stop = await openControllerStop({ journalPath: f.file, ticket: f.ticket, controller: f.controller, native: [f.child] });
    vi.useFakeTimers(); const before = Date.now();
    await stop.stop(before + 5000);
    expect(Date.now()).toBe(before); expect(f.trace).toEqual(["seal", "terminate"]);
    expect(f.kernel.sealAdmissions).toHaveBeenCalledExactlyOnceWith(f.jobHandle); expect(f.kernel.terminate).toHaveBeenCalledExactlyOnceWith(f.jobHandle);
    await stop.close();
  } finally { vi.useRealTimers(); Object.defineProperty(process, "platform", platform); }
});
