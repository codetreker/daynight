import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { once } from "node:events";
import { captureProcessProof } from "../../../src/commands/controller/process-proof.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { BotConfiguration, BotRecord } from "../../../src/commands/worker/bots/types.js";
import { BotEnvironmentCleanupError } from "../../../src/commands/worker/bots/environment.js";
import { BotCliProbeCleanupError } from "../../../src/commands/worker/bots/cli-probe.js";
import { ControllerStartupError } from "../../../src/commands/controller/startup.js";
import { ControllerIpcIdentityConflictError, ControllerIpcOutcomeUnknownError } from "../../../src/commands/controller/local-client.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { ControllerBootstrapReplacedError, ControllerLaunchJournalConflictError, ControllerLaunchJournalObservationError, type reconcileSubmittedControllerLaunch } from "../../../src/commands/controller/launch-observation.js";
import { cleanupBotProcesses, fixture, id } from "./bot-process.fixtures.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import * as storageLock from "../../../src/commands/controller/storage-lock.js";
import { ControllerStorageWaitingError } from "../../../src/commands/controller/storage-preparation.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";

afterEach(cleanupBotProcesses);

test.each(["codex","claude","copilot"] as const)("launches %s in an ordinary cwd with a persisted role and no user turn",async provider=>{
  const f=fixture(provider); const snapshot=await f.process.advance(f.current(),new AbortController().signal);
  expect(f.prepareEnvironment).toHaveBeenCalledWith(expect.objectContaining({ botId: f.current().botId, workerPaths: resolveConfigurationPaths(f.home) }));
  expect(snapshot.lifecycle).toBe("ready"); expect(f.getTicket()).toMatchObject({provider,cwd:f.home,initialInput:"none",initialPrompt:"",instructions:f.current().intent!.roleConfiguration!.instructions,resumeNativeSessionId:null});
  expect(f.getTicket()).not.toHaveProperty("claimId"); expect(f.getTicket()).not.toHaveProperty("workerId"); expect(f.getTicket().configuration.agentControlMode).toBe("web");
  expect(existsSync(path.join(f.home,".git"))).toBe(false); expect(f.executions.get(f.current())!.launchSubmission).toBe("acknowledged"); expect(f.release).not.toHaveBeenCalled();
  await f.process.advance(f.current(),new AbortController().signal); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1); expect(f.prepareEnvironment).toHaveBeenCalledTimes(1);
});

test("reconciles an accepted registration with a lost response using the original role and identity",async()=>{
  const f=fixture(); const register=f.register.getMockImplementation()!;
  f.register.mockImplementationOnce(async record=>{await register(record);throw new Error("response lost");});
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow("response lost"); const original=f.current().intent!;
  f.store.observe(f.owner,f.getBot(),2);
  await f.process.advance(f.current(),new AbortController().signal);
  expect(f.current().intent).toMatchObject({launchId:original.launchId,botVersion:"1",roleConfiguration:original.roleConfiguration}); expect(f.register).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});

test("never repeats a possible spawn even after constructing a new process manager",async()=>{
  const f=fixture(); f.launch.mockImplementationOnce(async options=>{await options.onSubmitting();throw new Error("spawn outcome unknown");});
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow("spawn outcome unknown");
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown"); f.observe.mockRejectedValueOnce(new ControllerIpcOutcomeUnknownError("IPC unavailable"));
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow(/spawn proof.*unavailable/);
  expect((await f.createProcess().advance(f.current(),new AbortController().signal)).lifecycle).toBe("ready"); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1);
});

test("retains an explicit IPC identity conflict when legacy spawn proof is missing", async () => {
  const f = fixture();
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); throw new Error("spawn outcome unknown"); });
  await expect(f.process.advance(f.current(), new AbortController().signal)).rejects.toThrow("spawn outcome unknown");
  const conflict = new Error("Controller IPC snapshot fence mismatch."); f.observe.mockRejectedValueOnce(conflict);
  await expect(f.process.advance(f.current(), new AbortController().signal)).rejects.toBe(conflict);
  expect(f.executions.get(f.current())!.lastError).toContain("fence mismatch");
  expect(f.launch).toHaveBeenCalledOnce();
});

test("rejects unsupported native configuration before registration and leaves failures visible",async()=>{
  const f=fixture(); const old=f.current().definition!;
  // The initial authoritative definition already contains the unsupported configuration.
  const other={...old,id:id(33),resolvedConfiguration:{...old.resolvedConfiguration,args:["--unsafe","yes"]}};
  f.store.observe(f.owner,other,1); await expect(f.process.advance(f.store.get(f.owner,other.id)!,new AbortController().signal)).rejects.toThrow(/Unsupported/);
  expect(f.register).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});

test("renews only expiring credentials and retains the observed native identity",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  await f.process.advance(f.current(),signal); await f.process.refreshGrant(f.current(),signal);expect(f.grant).toHaveBeenCalledTimes(1);
  writeFileSync(f.getTicket().credentialFile,JSON.stringify({expiresAt:new Date(Date.now()+60000).toISOString()}));
  await f.process.refreshGrant(f.current(),signal);expect(f.grant).toHaveBeenCalledTimes(2);
  expect(f.grant.mock.calls[1]![0].intent!.nativeSessionId).toBe(id(9));expect(f.launch).toHaveBeenCalledTimes(1);
  writeFileSync(f.getTicket().credentialFile,"{}");await expect(f.process.refreshGrant(f.current(),signal)).rejects.toThrow(/expiry/);expect(f.grant).toHaveBeenCalledTimes(2);
});

test("rejects a conflicting stored ticket without spawning or overwriting it",async()=>{
  const f=fixture(), signal=new AbortController().signal;await f.process.advance(f.current(),signal);
  const file=f.current().intent!.ticketPath;writeFileSync(file,JSON.stringify({...f.getTicket(),instructions:"different role"}),{mode:0o600});
  await expect(f.createProcess().advance(f.current(),signal)).rejects.toThrow(/ticket conflicts/);expect(f.launch).toHaveBeenCalledTimes(1);
});

test("retains registration and releases unsubmitted aliases when grant preparation fails",async()=>{
  const f=fixture(), signal=new AbortController().signal;f.grant.mockRejectedValueOnce(new Error("grant denied"));
  await expect(f.process.advance(f.current(),signal)).rejects.toThrow("grant denied");expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.executions.get(f.current())!.launchSubmission).toBe("not-submitted");
  await f.process.advance(f.current(),signal);expect(f.register).toHaveBeenCalledTimes(1);expect(f.launch).toHaveBeenCalledTimes(1);
});

test("retains an explicit OS rejection across failed reporting and never spawns again",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  f.launch.mockImplementationOnce(async options=>{await options.onSubmitting();throw new ControllerStartupError({state:"failed",reasonCode:"controller_launch_failed"},"OS rejected spawn");});
  await expect(f.process.advance(f.current(),signal)).rejects.toMatchObject({observation:{state:"failed"}});
  expect(f.executions.get(f.current())!.startup).toEqual({state:"failed",reasonCode:"controller_launch_failed"});
  await expect(f.createProcess().advance(f.current(),signal)).rejects.toMatchObject({observation:{state:"failed"}});
  expect(f.launch).toHaveBeenCalledTimes(1);expect(f.observe).not.toHaveBeenCalled();
});

const recoveryFixture = async (configuration: Partial<BotConfiguration> = {}, unacknowledged = false, starting = false, recoveryLimit = 3) => {
  const f = fixture("codex", configuration), signal = new AbortController().signal;
  const proof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64) };
  if (unacknowledged) {
    f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); await options.onSpawned(proof); throw new Error("observation unavailable"); });
    await expect(f.process.advance(f.current(), signal)).rejects.toThrow("observation unavailable");
  } else if (starting) {
    f.launch.mockImplementationOnce(async options => {
      await options.onSubmitting(); await options.onSpawned(proof);
      const snapshot: ControllerSnapshot = { ...await f.observe(options.ticket), controllerProcess: proof, lifecycle: "starting", nativeSessionId: null, startup: { state: "starting", reasonCode: "initializing" } };
      await options.onObserved(snapshot); return snapshot;
    });
    await f.createProcess({}, recoveryLimit).advance(f.current(), signal);
  } else await f.createProcess({}, recoveryLimit).advance(f.current(), signal);
  let saved: ControllerSnapshot = { ...(unacknowledged ? await f.observe(await f.process.readTicket(f.current())) : f.executions.get(f.current())!.snapshot!), controllerProcess: proof };
  f.executions.update(f.current(), { snapshot: saved });
  const confirmStopped = vi.fn(async () => false);
  const stopProcesses = vi.fn(async () => { confirmStopped.mockResolvedValue(true); });
  const request = vi.fn(async () => ({ snapshot: saved }));
  const recordStopped = vi.fn(async () => (saved = { ...saved, lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-05T00:00:00Z" }));
  f.observe.mockImplementation(async () => { if (saved.nativeStopped) throw new Error("IPC unavailable"); return saved; });
  let exited = false;
  const stopBootstrap = vi.fn(async () => { exited = true; });
  const reconcileLaunch = vi.fn<typeof reconcileSubmittedControllerLaunch>(async ({ ticket, spawnProof }) => {
    if (exited || await confirmStopped()) {
      if (ticket.executionGeneration !== saved.executionGeneration) return { kind: "pre-writer-exited" as const, process: spawnProof, journal: "preceding-generation" as const };
      return { kind: "controller-exited" as const, process: spawnProof, snapshot: saved };
    }
    try { return { kind: "observed" as const, snapshot: await f.observe(ticket) }; }
    catch { return { kind: "running-unobserved" as const, process: spawnProof }; }
  });
  const deps = { confirmStopped, stopProcesses, request, recordStopped, readSnapshot: () => saved, reconcileLaunch, stopBootstrap };
  return { ...f, signal, deps, manager: f.createProcess(deps, recoveryLimit), saved: () => saved,
    patch: (patch: Partial<ControllerSnapshot>) => { saved = { ...saved, ...patch } as ControllerSnapshot; },
    restart: () => f.createProcess(deps, recoveryLimit) };
};

test("shutdown retains Bot artifacts and restart resumes the original native session with a new generation", async () => {
  const f = await recoveryFixture(), original = f.current().intent!;
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.executions.get(f.current())).toMatchObject({ restartAfterShutdown: true, recoveryCount: 0, snapshot: { nativeStopped: true } });
  expect(existsSync(original.ticketPath)).toBe(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.getTicket()).toMatchObject({ executionGeneration: "2", sessionId: original.sessionId, testExecutionId: original.executionId, resumeNativeSessionId: id(9), instructions: original.roleConfiguration!.instructions, initialInput: "none", initialPrompt: "" });
  expect(f.current().intent!.registration).toEqual(original.registration);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.grant.mock.calls.at(-1)).toHaveLength(3);
});

test("closed new admission preserves shutdown and recovery of the original native conversation", async () => {
  const f = await recoveryFixture(), original = f.current().intent!;
  f.setAdmission(false);
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.saved()).toMatchObject({ nativeStopped: true, nativeSessionId: id(9) });
  await expect(f.restart().advance(f.current(), f.signal)).resolves.toMatchObject({ lifecycle: "ready", nativeSessionId: id(9) });
  expect(f.current().intent).toMatchObject({ executionId: original.executionId, nativeSessionId: id(9), executionGeneration: "2" });
  expect(f.getTicket()).toMatchObject({ resumeNativeSessionId: id(9), executionGeneration: "2", initialInput: "none" });
  expect(f.register).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test("IPC loss with a live writer cannot grant or launch a new generation", async () => {
  const f = await recoveryFixture(); f.observe.mockRejectedValue(new Error("unreachable"));
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow(/stop|running|unreachable/i);
  expect(f.current().intent!.executionGeneration).toBe("1");
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});

test("shutdown fails visibly when its stop receipt cannot prove the process tree stopped", async () => {
  const f = await recoveryFixture(); f.deps.stopProcesses.mockRejectedValue(new Error("cannot stop original process"));
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow(/cannot stop/);
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.current().intent!.executionGeneration).toBe("1");
});

test("recovery keeps its persisted target generation after a lost grant response", async () => {
  const f = await recoveryFixture(); await f.manager.shutdown(f.current(), f.signal);
  f.grant.mockRejectedValueOnce(new Error("response lost"));
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow("response lost");
  const target = f.current().intent!;
  await f.restart().advance(f.current(), f.signal);
  expect(f.current().intent).toEqual(target); expect(f.launch).toHaveBeenCalledTimes(2);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
});

test("an abnormal stopped writer consumes one recovery attempt and a healthy later shutdown does not reset it", async () => {
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(1);
  expect(f.current().intent!.executionGeneration).toBe("2");
});

test.each(["reader_busy", "physical_capacity"] as const)("Bot recovery retains its original generation and budget while storage waits for %s", async reason => {
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  const original = f.current().intent!, cause = new Error("Storage preparation is waiting.");
  f.prepareStorage.mockReturnValueOnce({ kind: "waiting", reason, cause });
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toMatchObject({ reason, cause });
  expect(f.current().intent).toEqual(original);
  expect(f.executions.get(f.current())).toMatchObject({ recoveryCount: 0, snapshot: { lifecycle: "stopped", nativeStopped: true } });
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.prepareStorage).toHaveBeenCalledWith({ journalFile: original.journalPath, stateDirectory: resolveConfigurationPaths(f.home).stateDirectory, mode: "stopped-maintenance", ticket: expect.objectContaining({ launchId: original.launchId }) }, expect.objectContaining({ journalFile: original.journalPath }));
  await f.restart().advance(f.current(), f.signal);
  expect(f.current().intent!.executionGeneration).toBe("2");
  expect(f.executions.get(f.current())!.recoveryCount).toBe(1);
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test("Bot recovery waits for the execution storage owner without recording stop or spending recovery", async () => {
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  const original = f.current().intent!, permit = acquireControllerStoragePermit(original.journalPath);
  try {
    await expect(f.restart().advance(f.current(), f.signal)).rejects.toBeInstanceOf(ControllerStorageWaitingError);
    expect(f.current().intent).toEqual(original);
    expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
    expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.prepareStorage).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
  } finally { permit.release(); }
  await f.restart().advance(f.current(), f.signal);
  expect(f.current().intent!.executionGeneration).toBe("2");
});

test.each([true, false])("Bot recovery releases storage only after the stopped journal connection is closed (%s)", async connectionClosed => {
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  const original = f.current().intent!;
  const failure = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "close" }, { connectionClosed, outcome: "unknown", cause: new Error("Stop connection close failed.") });
  f.deps.recordStopped.mockRejectedValueOnce(failure);
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toBe(failure);
  expect(f.current().intent).toEqual(original);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
  expect(f.prepareStorage).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledTimes(1);
  if (connectionClosed) {
    const permit = acquireControllerStoragePermit(original.journalPath);
    permit.release();
  } else {
    expect(() => acquireControllerStoragePermit(original.journalPath)).toThrow();
    expect(existsSync(path.join(path.dirname(original.journalPath), "storage.lock"))).toBe(true);
  }
});

test("Bot recovery retains the committed stop outcome when storage ownership release fails", async () => {
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  const original = f.current().intent!, permit = acquireControllerStoragePermit(original.journalPath);
  const failure = new Error("Storage ownership release failed.");
  const acquire = vi.spyOn(storageLock, "acquireControllerStoragePermit").mockReturnValue({ ...permit, release: () => { throw failure; } });
  try {
    const result = await f.restart().advance(f.current(), f.signal).catch(error => error);
    expect(result).toBeInstanceOf(SqliteAccessError);
    expect(result).toMatchObject({ kind: "cleanup-failed", context: { phase: "release", file: original.journalPath }, outcome: "committed", connectionClosed: true, cause: failure });
    expect(f.executions.get(f.current())).toMatchObject({ recoveryCount: 0, snapshot: { lifecycle: "stopped", nativeStopped: true } });
    expect(f.current().intent).toEqual(original);
    expect(f.launch).toHaveBeenCalledTimes(1); expect(f.grant).toHaveBeenCalledTimes(1);
  } finally { acquire.mockRestore(); permit.release(); }
});

test("a failed native stop remains blocked after bootstrap exits until complete stop is proven", async () => {
  const f = await recoveryFixture();
  f.deps.stopProcesses.mockRejectedValueOnce(new Error("stop failed"));
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow("stop failed");
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(true);
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow(/stop is unproven/);
  f.deps.confirmStopped.mockResolvedValue(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
});

test("shutdown ignores a never-started deletion projection without inventing a missing writer", async () => {
  const f = fixture();
  const deleted = f.store.observe(f.owner, { id: id(88), workerId: f.owner.workerId, version: "2", deletion: { deletionId: id(89), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 1);
  expect(deleted.definition).toBeNull();
  await expect(f.process.shutdown(deleted, new AbortController().signal)).resolves.toBeUndefined();
});

test("shutdown stops a persisted recovery child before reporting that its journal still belongs to the predecessor", async () => {
  const f = await recoveryFixture();
  await f.manager.shutdown(f.current(), f.signal);
  const previous = f.saved();
  const nextProof = { ...previous.controllerProcess!, pid: 456, processGroupId: 456, startedAt: "next-child" };
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting(); await options.onSpawned(nextProof);
    throw new Error("cancelled before child opens journal");
  });
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow("cancelled before child opens journal");
  expect(f.current().intent!.executionGeneration).toBe("2");
  f.deps.confirmStopped.mockResolvedValue(false);
  f.deps.stopProcesses.mockClear(); f.deps.stopBootstrap.mockClear();
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => ({ kind: "running-unobserved", process: spawnProof }));
  await expect(f.restart().shutdown(f.current(), f.signal)).rejects.toThrow(/before committing.*preceding-generation/);
  expect(f.deps.stopBootstrap).toHaveBeenCalledWith(nextProof, expect.any(Number));
  expect(f.deps.stopProcesses).not.toHaveBeenCalled();
  expect(f.executions.get(f.current())).toMatchObject({ controllerProcess: nextProof, launchSubmission: "unknown", snapshot: null });
});

const markDeleting = (f: ReturnType<typeof fixture>): BotRecord => {
  const prior = f.current();
  return f.store.observe(f.owner, { id: prior.botId, workerId: f.owner.workerId, version: String(BigInt(prior.observed.version) + 1n), deletion: { deletionId: id(90), requestedVersion: prior.observed.version, workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 2);
};

test("retains child and observed writer evidence when deletion arrives after spawn submission", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const proof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64) };
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting();
    markDeleting(f);
    await options.onSpawned(proof);
    const value: ControllerSnapshot = { executionId: options.ticket.executionId, testExecutionId: options.ticket.executionId, sessionId: options.ticket.sessionId, executionGeneration: "1", controllerInstanceId: options.ticket.controllerInstanceId, lifecycle: "ready", nativeSessionId: id(9), initialInputState: "not_required", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: true }, controllerProcess: proof, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null, startup: { state: "ready", reasonCode: "ready" } };
    await options.onObserved(value);
    return value;
  });
  await f.process.advance(f.current(), signal);
  expect(f.executions.get(f.current())).toMatchObject({ launchSubmission: "acknowledged", controllerProcess: proof, snapshot: { controllerProcess: proof, nativeSessionId: id(9) } });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow(/active definition/);
  expect(f.launch).toHaveBeenCalledTimes(1);
});

test("does not write a late grant or spawn after observing deletion during grant preparation", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const grant = f.grant.getMockImplementation()!;
  f.grant.mockImplementationOnce(async record => { const result = await grant(record); markDeleting(f); return result; });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow(/active definition/);
  expect(existsSync(f.current().intent!.credentialFile)).toBe(false);
  expect(f.executions.get(f.current())!.launchSubmission).toBe("not-submitted");
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.launch).not.toHaveBeenCalled();
});

test("deletion returns the original stopped fence and retains journal ownership until its callback finishes", async () => {
  const f = await recoveryFixture(), original = f.current().intent!, record = markDeleting(f);
  const stop = await f.manager.withDeletion(record, f.signal, async stop => {
    const proof = await stop();
    expect(f.executions.get(f.current())!.snapshot).toMatchObject({ nativeStopped: true, lifecycle: "stopped" });
    expect(existsSync(original.ticketPath)).toBe(true);
    return proof;
  });
  expect(stop).toEqual({ protocol: "daynight.session.v1", sessionId: original.sessionId, testExecutionId: original.executionId, executionGeneration: "1", controllerId: original.registration.controllerId, controllerInstanceId: original.controllerInstanceId, stopProof: { recordId: original.launchId, previousControllerInstanceId: original.controllerInstanceId, stoppedAt: "2026-11-05T00:00:00Z" } });
});

test("an IPC stop acknowledgement cannot release Bot files while its original writer remains alive", async () => {
  const f = await recoveryFixture(), record = markDeleting(f);
  f.deps.stopProcesses.mockImplementation(async () => {});
  let released = false;
  await expect(f.manager.withDeletion(record, f.signal, async stop => { await stop(); released = true; })).rejects.toThrow(/did not stop/);
  expect(released).toBe(false);
  expect(existsSync(record.intent!.ticketPath)).toBe(true);
  expect(f.executions.get(f.current())!.snapshot!.nativeStopped).toBe(false);
});

test("deletion resumes a persisted cleanup without reopening a removed journal", async () => {
  const f = await recoveryFixture(), record = markDeleting(f);
  await f.manager.withDeletion(record, f.signal, async stop => { await stop(); });
  f.deps.recordStopped.mockClear();
  f.deps.recordStopped.mockRejectedValue(new Error("journal removed"));
  const result = await f.manager.withDeletion(record, f.signal, async () => "persisted stop already owns cleanup");
  expect(result).toBe("persisted stop already owns cleanup");
  expect(f.deps.recordStopped).not.toHaveBeenCalled();
});

test("only an unsubmitted first generation can attest never started", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.grant.mockRejectedValueOnce(new Error("grant denied"));
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("grant denied");
  const original = f.current().intent!, record = markDeleting(f);
  const proof = await f.process.withDeletion(record, signal, stop => stop());
  expect(proof).toMatchObject({ sessionId: original.sessionId, executionGeneration: "1", stopProof: { kind: "never_started", recordId: original.launchId, previousControllerInstanceId: original.controllerInstanceId } });
  expect(f.launch).not.toHaveBeenCalled();
});

test("an unsubmitted recovery with unknown server generation cannot manufacture a deletion stop proof", async () => {
  const f = await recoveryFixture();
  await f.manager.shutdown(f.current(), f.signal);
  f.grant.mockRejectedValueOnce(new Error("response lost"));
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow("response lost");
  const record = markDeleting(f);
  await expect(f.manager.withDeletion(record, f.signal, stop => stop())).rejects.toThrow(/generation.*unconfirmed/);
  expect(f.current().intent!.executionGeneration).toBe("2");
  expect(existsSync(record.intent!.ticketPath)).toBe(true);
});

test("deletion rejects another request identity before entering its cleanup callback", async () => {
  const f = fixture(), record = markDeleting(f);
  const stale = { ...record, observed: { ...record.observed, deletion: { ...record.observed.deletion!, deletionId: id(91) } } };
  let entered = false;
  await expect(f.process.withDeletion(stale, new AbortController().signal, async () => { entered = true; })).rejects.toThrow(/deletion identity/);
  expect(entered).toBe(false);
});

test("deletion waits for a submitted launch to finish and excludes later recovery until cleanup returns", async () => {
  const f = fixture(), signal = new AbortController().signal;
  let releaseLaunch!: () => void, submitted!: () => void, releaseCleanup!: () => void;
  const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
  const submission = new Promise<void>(resolve => { submitted = resolve; });
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); submitted(); await launchGate; throw new Error("submitted launch is now observed"); });
  const launch = f.process.advance(f.current(), signal);
  const launched = expect(launch).rejects.toThrow("submitted launch is now observed");
  await submission;
  const record = markDeleting(f);
  let entered = false, restarted = false;
  const cleanup = f.process.withDeletion(record, signal, async () => { entered = true; await cleanupGate; });
  const restart = f.process.advance(record, signal).catch(error => { restarted = true; throw error; });
  const rejected = expect(restart).rejects.toThrow(/active definition/);
  await Promise.resolve();
  expect(entered).toBe(false);
  releaseLaunch(); await launched;
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(restarted).toBe(false);
  releaseCleanup(); await cleanup; await rejected;
  expect(f.launch).toHaveBeenCalledTimes(1);
});

test("deletion preserves an unknown spawn without a process proof instead of claiming never started", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); throw new Error("unknown submission"); });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("unknown submission");
  f.observe.mockRejectedValue(new Error("unavailable"));
  const record = markDeleting(f);
  await expect(f.process.withDeletion(record, signal, stop => stop())).rejects.toThrow(/spawn proof/);
  expect(existsSync(record.intent!.ticketPath)).toBe(true);
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown");
});

test("deletion can attest a definite rejected first spawn without inventing a native process", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); throw new ControllerStartupError({ state: "failed", reasonCode: "controller_launch_failed" }, "OS rejected spawn"); });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("OS rejected spawn");
  const record = markDeleting(f);
  expect(await f.process.withDeletion(record, signal, stop => stop())).toMatchObject({ executionGeneration: "1", stopProof: { kind: "never_started" } });
  expect(f.observe).not.toHaveBeenCalled();
});

test("deletion retains registration identity when the accepted registration response is lost before its Session binding is observed", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const register = f.register.getMockImplementation()!;
  f.register.mockImplementationOnce(async record => {
    await register(record);
    f.store.observe(f.owner, { id: record.botId, workerId: f.owner.workerId, version: "3", deletion: { deletionId: id(90), requestedVersion: "2", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 3);
    throw new Error("accepted registration response lost");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("accepted registration response lost");
  const record = f.current(), original = record.intent!;
  expect(original.sessionId).toBeNull();
  let released = false;
  await expect(f.process.withDeletion(record, signal, async stop => { await stop(); released = true; })).rejects.toThrow(/registration outcome.*unconfirmed/);
  expect(released).toBe(false);
  expect(f.current().intent).toEqual(original);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.launch).not.toHaveBeenCalled();
});

test("deletion retries a failed prepared alias release before completing an unregistered Bot", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const alias = path.join(f.home, "state", "agent-cli-aliases", "execution-prepared");
  mkdirSync(alias, { recursive: true }); writeFileSync(path.join(alias, "daynight"), "private shim");
  f.release.mockRejectedValueOnce(new Error("EACCES: initial release failed"))
    .mockRejectedValueOnce(new Error("EACCES: deletion release failed"))
    .mockImplementation(async () => { rmSync(alias, { recursive: true }); });
  const manager = f.createProcess({ prepareEnvironment: async () => {
    markDeleting(f);
    return { environment: {}, aliasDirectory: alias, bindings: [], release: f.release };
  } });
  await expect(manager.advance(f.current(), signal)).rejects.toThrow("EACCES: initial release failed");
  const record = f.current(); expect(record.intent).toBeNull();
  let completed = false;
  await expect(manager.withDeletion(record, signal, async stop => { await stop(); completed = true; })).rejects.toThrow("EACCES: deletion release failed");
  expect(completed).toBe(false); expect(existsSync(alias)).toBe(true);
  expect(await manager.withDeletion(record, signal, stop => stop())).toBeNull();
  expect(existsSync(alias)).toBe(false);
  expect(await manager.withDeletion(record, signal, stop => stop())).toBeNull();
  expect(f.release).toHaveBeenCalledTimes(3);
  expect(f.register).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});

test("deletion retains a failed preflight probe and its aliases until the original cleanup retry succeeds", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const alias = path.join(f.home, "state", "agent-cli-aliases", "execution-probe");
  mkdirSync(alias, { recursive: true }); writeFileSync(path.join(alias, "daynight"), "private shim");
  const retryCleanup = vi.fn(async () => {}).mockRejectedValueOnce(new Error("original probe still running"));
  const failure = new BotEnvironmentCleanupError(alias, new BotCliProbeCleanupError({ launchId: id(95), pid: null, process: null, jobObjectName: null, targetStarted: false }, retryCleanup));
  const manager = f.createProcess({ prepareEnvironment: async () => { markDeleting(f); throw failure; } });
  await expect(manager.advance(f.current(), signal)).rejects.toBe(failure);
  const record = f.current(); expect(record.intent).toBeNull();
  let completed = false;
  await expect(manager.withDeletion(record, signal, async stop => { await stop(); completed = true; })).rejects.toThrow("original probe still running");
  expect(completed).toBe(false); expect(existsSync(alias)).toBe(true);
  expect(await manager.withDeletion(record, signal, stop => stop())).toBeNull();
  expect(existsSync(alias)).toBe(false);
  expect(await manager.withDeletion(record, signal, stop => stop())).toBeNull();
  expect(retryCleanup).toHaveBeenCalledTimes(2);
  expect(f.register).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});

test("freezes the current recovery limit only when preparing the original Bot intent", async () => {
  const f = fixture(); let limit = 7;
  const process = f.createProcess({}, () => limit), signal = new AbortController().signal;
  await process.advance(f.current(), signal);
  expect(f.current().intent!.recoveryLimit).toBe(7);
  limit = 1; await process.advance(f.current(), signal);
  expect(f.current().intent!.recoveryLimit).toBe(7);
  expect(f.launch).toHaveBeenCalledTimes(1);
});


test.each(["codex", "claude", "copilot"] as const)("maps frozen %s selection into one validated launch configuration", async provider => {
  const f = fixture(provider, { model: "chosen-model", args: ["--effort", "low", "--effort", "medium"], reasoningEffort: "native-new-level",
    selection: { schemaVersion: 1, modelSource: "explicit", reasoningEffortSource: "explicit" } });
  await f.process.advance(f.current(), new AbortController().signal);
  expect(f.getTicket().configuration).toEqual({ agent: provider, agentControlMode: "web", model: "chosen-model", args: ["--effort", "native-new-level"], recoveryLimit: 3, validateNativeSelection: true, toolLaunch: f.current().intent!.toolLaunch });
  expect(f.register.mock.calls[0]![0].definition?.resolvedConfiguration).toEqual(f.getBot().resolvedConfiguration);
  await f.createProcess().advance(f.current(), new AbortController().signal);
  expect(f.launch).toHaveBeenCalledTimes(1);
});

test("keeps a frozen native effort delegation clear of inherited argument defaults", async () => {
  const f = fixture("codex", { model: null, args: ["--model", "stale", "--effort", "high", "--sandbox", "read-only"], reasoningEffort: null,
    selection: { schemaVersion: 1, modelSource: "native", reasoningEffortSource: "native" } });
  await f.process.advance(f.current(), new AbortController().signal);
  expect(f.getTicket().configuration).toEqual({ agent: "codex", agentControlMode: "web", model: null, args: ["--sandbox", "read-only"], recoveryLimit: 3, toolLaunch: f.current().intent!.toolLaunch });
});


test("rejects removal of the frozen selection validation from a new Bot ticket", async () => {
  const f = fixture("copilot", { model: "chosen-model", args: [], reasoningEffort: "none", selection: { schemaVersion: 1, modelSource: "explicit", reasoningEffortSource: "explicit" } });
  const signal = new AbortController().signal;
  await f.process.advance(f.current(), signal);
  const ticket = f.getTicket(), { validateNativeSelection: _validation, ...configuration } = ticket.configuration;
  writeFileSync(f.current().intent!.ticketPath, JSON.stringify({ ...ticket, configuration }), { mode: 0o600 });
  await expect(f.createProcess().advance(f.current(), signal)).rejects.toThrow(/selection validation/);
  expect(f.launch).toHaveBeenCalledTimes(1);
});


test.each([
  { model: "chosen-model", reasoningEffort: null, modelSource: "explicit", reasoningEffortSource: "native", args: [] },
  { model: null, reasoningEffort: "high", modelSource: "native", reasoningEffortSource: "explicit", args: ["--effort", "high"] },
] as const)("preserves independent frozen selection %j", async selection => {
  const f = fixture("codex", { model: selection.model, reasoningEffort: selection.reasoningEffort, selection: { schemaVersion: 1, modelSource: selection.modelSource, reasoningEffortSource: selection.reasoningEffortSource } });
  await f.process.advance(f.current(), new AbortController().signal);
  expect(f.getTicket().configuration).toMatchObject({ model: selection.model, args: selection.args, validateNativeSelection: true });
});

test("keeps new frozen model and effort through original-session recovery", async () => {
  const f = await recoveryFixture({ model: "chosen-model", args: ["--effort", "low"], reasoningEffort: "high", selection: { schemaVersion: 1, modelSource: "explicit", reasoningEffortSource: "explicit" } });
  const original = f.getTicket();
  await f.manager.shutdown(f.current(), f.signal);
  await f.restart().advance(f.current(), f.signal);
  expect(f.getTicket()).toMatchObject({ resumeNativeSessionId: id(9), executionGeneration: "2", sessionId: original.sessionId, configuration: original.configuration });
  expect(f.register).toHaveBeenCalledTimes(1);
});

test.each(["running-unobserved", "pre-writer-exited", "unknown"] as const)("keeps submitted Bot identity and never acknowledges %s", async kind => {
  const f = await recoveryFixture({}, true);
  const original = f.current().intent!;
  f.deps.reconcileLaunch.mockImplementation(async ({ spawnProof }) => kind === "running-unobserved"
    ? { kind, process: spawnProof }
    : kind === "pre-writer-exited"
      ? { kind, process: spawnProof, journal: "preceding-generation" }
      : { kind, cause: new Error("process inspection unavailable") });
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow();
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown");
  expect(f.current().intent).toEqual(original);
  expect(f.launch).toHaveBeenCalledTimes(1); expect(f.grant).toHaveBeenCalledTimes(1);
  expect(f.deps.recordStopped).not.toHaveBeenCalled();
});

test.each(["missing", "preceding-generation"] as const)("Bot cleanup retains pre-writer %s and finishes despite business cancellation", async journal => {
  const f = await recoveryFixture({}, true);
  const abort = new AbortController(); abort.abort(new Error("business cancelled"));
  f.deps.reconcileLaunch.mockImplementation(async ({ spawnProof }) => ({ kind: "pre-writer-exited", process: spawnProof, journal }));
  await expect(f.manager.shutdown(f.current(), abort.signal)).rejects.toThrow(/before committing/);
  expect(f.deps.stopBootstrap).not.toHaveBeenCalled();
  expect(f.deps.stopProcesses).not.toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown");
  expect(f.current().intent!.executionGeneration).toBe("1");
});


test("Bot cleanup uses committed proof after original exit without signaling a replacement PID", async () => {
  const f = await recoveryFixture();
  f.deps.reconcileLaunch.mockImplementation(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: f.saved() }));
  f.deps.stopBootstrap.mockRejectedValue(new Error("replacement PID must not be signaled"));
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.deps.stopBootstrap).not.toHaveBeenCalled();
  expect(f.deps.stopProcesses).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, expect.any(Number));
  expect(f.deps.recordStopped).toHaveBeenCalledOnce();
});


test("Bot reclassifies a process replaced between observation and stop", async () => {
  const f = await recoveryFixture();
  const replacement = new ControllerBootstrapReplacedError("original instance exited");
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => ({ kind: "running-unobserved", process: spawnProof }))
    .mockImplementationOnce(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: f.saved() }));
  f.deps.stopBootstrap.mockRejectedValueOnce(replacement);
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.deps.reconcileLaunch).toHaveBeenCalledTimes(2);
  expect(f.deps.stopProcesses).toHaveBeenCalledOnce(); expect(f.deps.recordStopped).toHaveBeenCalledOnce();
});

test("Bot preserves replacement and unknown classification errors without recording stopped", async () => {
  const f = await recoveryFixture();
  const replacement = new ControllerBootstrapReplacedError("original instance exited"), unknown = new Error("unknown process");
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => ({ kind: "running-unobserved", process: spawnProof }))
    .mockResolvedValueOnce({ kind: "unknown", cause: unknown });
  f.deps.stopBootstrap.mockRejectedValueOnce(replacement);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error.cause).toBeInstanceOf(AggregateError); expect(error.cause.errors).toEqual([replacement, unknown]);
  expect(f.deps.stopProcesses).not.toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
});

test("Bot preserves replacement when later full process stopping fails", async () => {
  const f = await recoveryFixture();
  const replacement = new ControllerBootstrapReplacedError("original instance exited"), failure = new Error("native stopping failed");
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => ({ kind: "running-unobserved", process: spawnProof }))
    .mockImplementationOnce(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: f.saved() }));
  f.deps.stopBootstrap.mockRejectedValueOnce(replacement); f.deps.stopProcesses.mockRejectedValueOnce(failure);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([replacement, failure]);
  expect(f.deps.recordStopped).not.toHaveBeenCalled();
});


test("shutdown saves a newly authenticated ready observation before orderly recovery with zero budget", async () => {
  const f = await recoveryFixture({}, false, true, 0), original = f.current().intent!;
  expect(f.executions.get(f.current())).toMatchObject({ startup: { state: "starting" }, snapshot: { lifecycle: "starting", nativeSessionId: null } });
  f.patch({ lifecycle: "ready", nativeSessionId: id(9), startup: { state: "ready", reasonCode: "ready" } });
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.executions.get(f.current())).toMatchObject({ startup: { state: "ready" }, snapshot: { lifecycle: "stopped", nativeSessionId: id(9) }, restartAfterShutdown: true });
  await f.restart().advance(f.current(), f.signal);
  expect(f.current().intent).toMatchObject({ executionGeneration: "2", nativeSessionId: id(9), sessionId: original.sessionId, recoveryLimit: 0 });
  expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
});

test("authenticated ready observation does not erase an earlier terminal startup failure", async () => {
  const f = await recoveryFixture({}, false, true, 0);
  const failed = { state: "failed", reasonCode: "native_rejected" } as const;
  f.executions.update(f.current(), { startup: failed, lastError: "native rejected", snapshot: { ...f.saved(), lifecycle: "failed", error: "native rejected", startup: failed } });
  f.patch({ lifecycle: "ready", nativeSessionId: id(9), startup: { state: "ready", reasonCode: "ready" } });
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.executions.get(f.current())).toMatchObject({ startup: failed, lastError: "native rejected", restartAfterShutdown: false });
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow(/budget is exhausted/);
});


test.each([false, true])("Bot shutdown retains observation failure and stops its original bootstrap (stop fails=%s)", async stopFails => {
  const f = await recoveryFixture(), original = f.current().intent!, refusal = new Error("Controller journal observation refused"), stopFailure = new Error("bootstrap stop failed");
  f.deps.reconcileLaunch.mockRejectedValueOnce(refusal);
  if (stopFails) f.deps.stopBootstrap.mockRejectedValueOnce(stopFailure);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  if (stopFails) expect(error.errors).toEqual([refusal, stopFailure]); else expect(error).toBe(refusal);
  expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopBootstrap).toHaveBeenCalledWith(f.executions.get(f.current())!.controllerProcess, expect.any(Number));
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.current().intent).toEqual(original); expect(f.release).not.toHaveBeenCalled();
  if (stopFails) expect(f.deps.stopProcesses).not.toHaveBeenCalled(); else expect(f.deps.stopProcesses).toHaveBeenCalledOnce();
});

test("Bot shutdown stops the original bootstrap after orderly provenance cannot be saved", async () => {
  const f = await recoveryFixture(), failure = new Error("Bot snapshot persistence failed");
  vi.spyOn(f.executions, "update").mockImplementationOnce(() => { throw failure; });
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error).toBe(failure); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopProcesses).toHaveBeenCalledOnce();
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test("Bot shutdown retains unknown process status after attempting original bootstrap stop", async () => {
  const f = await recoveryFixture(), unknown = new Error("process status unknown");
  f.deps.reconcileLaunch.mockResolvedValueOnce({ kind: "unknown", cause: unknown });
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error.cause).toBe(unknown); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopProcesses).toHaveBeenCalledOnce();
  expect(f.deps.recordStopped).not.toHaveBeenCalled();
});


test("Bot observation refusal still stops a real original bootstrap process", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n");setTimeout(()=>process.exit(0),10000)'], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close", { signal: AbortSignal.timeout(12_000) });
  try {
    await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    const proof = await captureProcessProof(child.pid!), f = fixture(), signal = new AbortController().signal;
    f.launch.mockImplementationOnce(async options => {
      await options.onSubmitting(); await options.onSpawned(proof);
      const snapshot = { ...await f.observe(options.ticket), controllerProcess: proof };
      await options.onObserved(snapshot); return snapshot;
    });
    await f.process.advance(f.current(), signal);
    const refusal = new Error("Controller journal observation refused"); let observations = 0;
    const reconcile = vi.fn<typeof reconcileSubmittedControllerLaunch>(async ({ spawnProof }) => {
      if (++observations === 1) throw refusal;
      return { kind: "pre-writer-exited", process: spawnProof, journal: "missing" };
    });
    const manager = f.createProcess({ reconcileLaunch: reconcile, stopBootstrap: stopControllerBootstrap });
    await expect(manager.shutdown(f.current(), signal)).rejects.toBe(refusal);
    await closed;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(f.executions.get(f.current())!.snapshot?.nativeStopped).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
  } finally { await closed; }
}, 20_000);

test("Bot fallback retains a still-running native tree after stopping the bootstrap", async () => {
  const f = await recoveryFixture(), refusal = new Error("Controller journal observation refused");
  f.deps.reconcileLaunch.mockRejectedValueOnce(refusal);
  f.deps.stopProcesses.mockImplementationOnce(async () => {});
  f.deps.confirmStopped.mockResolvedValue(false);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error.errors[0]).toBe(refusal); expect(error.errors[1].message).toMatch(/process tree did not stop/);
  expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test.each(["refused", "unknown"] as const)("Bot preserves a %s IPC stop after safely stopping the original process", async kind => {
  const f = await recoveryFixture(), original = f.current().intent!;
  const failure = kind === "refused" ? new Error("Controller stop refused") : new ControllerIpcOutcomeUnknownError("Controller stop response unavailable");
  f.executions.markShutdown(f.current(), true);
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(true);
  f.deps.request.mockRejectedValueOnce(failure);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error).toBe(failure); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopProcesses).toHaveBeenCalledOnce();
  expect(f.deps.confirmStopped).toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(true); expect(f.current().intent).toEqual(original); expect(f.release).not.toHaveBeenCalled();
  f.deps.confirmStopped.mockResolvedValue(false);
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow(/stop is unproven/);
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.current().intent).toEqual(original);
});




test.skipIf(process.platform === "win32")("Bot uses retained attributed POSIX proof when both journal reads fail with I/O", async () => {
  const f = await recoveryFixture(), ipc = new ControllerIpcOutcomeUnknownError("IPC unavailable");
  const io = () => new ControllerLaunchJournalObservationError(ipc, Object.assign(new Error("journal I/O"), { code: "EIO" }));
  const first = io(), second = io(); f.deps.reconcileLaunch.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error.errors).toEqual([first, second]); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce();
  expect(f.deps.stopProcesses).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, expect.any(Number));
  expect(f.deps.confirmStopped).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, expect.any(Number));
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32").each(["observed", "running-unobserved"] as const)("Bot cleans the retained tree when journal I/O fails after %s bootstrap stop", async kind => {
  const f = await recoveryFixture(), ipc = new ControllerIpcOutcomeUnknownError("IPC unavailable");
  const io = () => new ControllerLaunchJournalObservationError(ipc, Object.assign(new Error("journal I/O"), { code: "EIO" }));
  const first = io(), second = io();
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => kind === "observed" ? { kind, snapshot: f.saved() } : { kind, process: spawnProof })
    .mockRejectedValueOnce(first).mockRejectedValueOnce(second);
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error.errors).toEqual([first, second]); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce();
  expect(f.deps.stopProcesses).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, expect.any(Number));
  expect(f.deps.confirmStopped).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, expect.any(Number));
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== "win32")("Bot does not use a retained Job after bootstrap stop and journal I/O failure", async () => {
  const f = await recoveryFixture(), ipc = new ControllerIpcOutcomeUnknownError("IPC unavailable");
  const io = () => new ControllerLaunchJournalObservationError(ipc, Object.assign(new Error("journal I/O"), { code: "EIO" }));
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => ({ kind: "running-unobserved", process: spawnProof }))
    .mockRejectedValueOnce(io()).mockRejectedValueOnce(io());
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow();
  expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopProcesses).not.toHaveBeenCalled();
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test("Bot retries tree classification after persistence fails on an already exited controller", async () => {
  const f = await recoveryFixture(), failure = new Error("snapshot persistence failed");
  f.deps.reconcileLaunch.mockImplementation(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: f.saved() }));
  vi.spyOn(f.executions, "update").mockImplementationOnce(() => { throw failure; });
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error).toBe(failure); expect(f.deps.stopBootstrap).not.toHaveBeenCalled(); expect(f.deps.stopProcesses).toHaveBeenCalledOnce();
  expect(f.deps.confirmStopped).toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
});

test.each(["journal identity", "journal format", "IPC identity"] as const)("Bot blocks tree cleanup after first %s conflict even if a later snapshot is valid", async kind => {
  const f = await recoveryFixture(), ipc = new ControllerIpcOutcomeUnknownError("IPC unavailable");
  const io = Object.assign(new Error("journal I/O"), { code: "EIO" });
  const first = kind === "IPC identity" ? new ControllerIpcIdentityConflictError("IPC fence conflict") : new ControllerLaunchJournalObservationError(ipc, kind === "journal identity" ? new AggregateError([io, new ControllerLaunchJournalConflictError("identity conflict")]) : new SyntaxError("invalid journal"));
  f.deps.reconcileLaunch.mockRejectedValueOnce(first).mockImplementationOnce(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: f.saved() }));
  const error = await f.manager.shutdown(f.current(), f.signal).catch(error => error);
  expect(error).toBe(first); expect(f.deps.reconcileLaunch).toHaveBeenCalledOnce(); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce();
  expect(f.deps.stopProcesses).not.toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
});

test("Bot stops only the bootstrap when the IPC stop response has an identity conflict", async () => {
  const f = await recoveryFixture(), conflict = new ControllerIpcIdentityConflictError("stop fence conflict");
  f.deps.request.mockRejectedValueOnce(conflict);
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toBe(conflict);
  expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopProcesses).not.toHaveBeenCalled();
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test.each(["controller", "native session", "native process"] as const)("Bot blocks tree cleanup after an observed %s conflict", async kind => {
  const f = await recoveryFixture(), original = f.saved();
  const snapshot = kind === "controller" ? { ...original, controllerProcess: { ...original.controllerProcess!, commandHash: "b".repeat(64) } }
    : kind === "native session" ? { ...original, nativeSessionId: id(88) }
      : { ...original, nativeProcesses: [{ pid: 980, parentPid: 987, processGroupId: 987, startedAt: "original-native", commandHash: "b".repeat(64) }] };
  if (kind === "native process") f.executions.update(f.current(), { snapshot: { ...original, nativeProcesses: [{ pid: 981, parentPid: 987, processGroupId: 987, startedAt: "original-native", commandHash: "c".repeat(64) }] } });
  f.deps.reconcileLaunch.mockResolvedValueOnce({ kind: "observed", snapshot });
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow();
  expect(f.deps.stopBootstrap).toHaveBeenCalledOnce(); expect(f.deps.stopProcesses).not.toHaveBeenCalled();
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test("Bot blocks tree cleanup if an exited journal loses retained native proof", async () => {
  const f = await recoveryFixture(), original = f.saved();
  f.executions.update(f.current(), { snapshot: { ...original, nativeProcesses: [{ pid: 981, parentPid: 987, processGroupId: 987, startedAt: "original-native", commandHash: "c".repeat(64) }] } });
  f.deps.reconcileLaunch.mockImplementationOnce(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: original }));
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow(/conflicts/);
  expect(f.deps.stopBootstrap).not.toHaveBeenCalled(); expect(f.deps.stopProcesses).not.toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
});

test("Bot keeps the same Job lease after a failed stop response and releases it after a confirmed retry", async () => {
  const f = await recoveryFixture(), lease = {} as import("../../../src/commands/controller/windows-job.js").ControllerJobLease;
  const leases = { enabled: true, retain: vi.fn(async () => lease), get: vi.fn(async () => lease), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const manager = f.createProcess(f.deps, 3, leases), failure = new Error("stop response failed");
  f.deps.request.mockRejectedValueOnce(failure);
  await expect(manager.shutdown(f.current(), f.signal)).rejects.toBe(failure);
  expect(leases.retain).toHaveBeenCalledBefore(f.deps.request); expect(leases.retain).toHaveBeenCalledBefore(f.deps.stopBootstrap);
  const deadline = (f.deps.stopBootstrap.mock.calls[0]! as unknown as [unknown, number])[1];
  expect(f.deps.stopProcesses).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, deadline, lease);
  expect(f.deps.confirmStopped).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, deadline, lease);
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(leases.release).not.toHaveBeenCalled();
  await manager.shutdown(f.current(), f.signal);
  expect(f.deps.recordStopped).toHaveBeenCalledWith(f.current().intent!.journalPath, expect.anything(), { stateDirectory: resolveConfigurationPaths(f.home).stateDirectory, deadline: expect.any(Number), jobLease: lease });
  expect(leases.release).toHaveBeenCalledOnce();
});

test("Bot still stops its bootstrap if original Job acquisition fails", async () => {
  const f = await recoveryFixture(), failure = new Error("Job identity unavailable"), incomplete = new Error("Job lease required");
  const leases = { enabled: true, retain: vi.fn(async () => { throw failure; }), get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  f.deps.stopProcesses.mockRejectedValue(incomplete);
  const error = await f.createProcess(f.deps, 3, leases).shutdown(f.current(), f.signal).catch(error => error);
  expect(error.errors).toEqual([failure, incomplete]); expect(f.deps.stopBootstrap).toHaveBeenCalledOnce();
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(leases.release).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});

test.each(["valid", "missing", "generation", "process"] as const)("Bot recovery after Worker restart requires its committed Windows Job proof (%s)", async kind => {
  const f = fixture("codex", {}, true), signal = new AbortController().signal;
  const spawnProof = { pid: 123, parentPid: 12, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64) };
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting(); await options.onSpawned(spawnProof);
    const snapshot = { ...await f.observe(options.ticket), controllerProcess: { ...spawnProof, jobObjectName: `Local\\Daynight-${options.ticket.launchId}` } };
    await options.onObserved(snapshot); return snapshot;
  });
  await f.process.advance(f.current(), signal);
  const ticket = await f.process.readTicket(f.current()), original = f.executions.get(f.current())!.snapshot!;
  const controller = { ...spawnProof, jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  f.executions.markShutdown(f.current(), true);
  const file = f.current().intent!.journalPath; mkdirSync(path.dirname(file), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(file, ticket, { onMigration: () => {} });
  journal.patchSnapshot({ controllerProcess: controller, nativeSessionId: original.nativeSessionId, lifecycle: "ready", ...(original.startup === undefined ? {} : { startup: original.startup }), error: null }); journal.close();
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const stopped = await lifecycle.recordStoppedControllerGeneration(file, ticket, { stateDirectory: resolveConfigurationPaths(f.home).stateDirectory, deadline: Date.now() + 5000, jobLease: {} as never });
    f.executions.update(f.current(), { snapshot: stopped }); f.reopen();
    if (kind !== "valid") {
      const db = new Database(file), row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }, value = JSON.parse(row.snapshot);
      if (kind === "missing") delete value.windowsJobStopProof;
      if (kind === "generation") value.executionGeneration = "2";
      if (kind === "process") value.controllerProcess.commandHash = "b".repeat(64);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); db.close();
    }
    const leases = { enabled: true, retain: vi.fn(async () => undefined), get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const reconcile = vi.fn<typeof reconcileSubmittedControllerLaunch>(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: lifecycle.readControllerSnapshot(file)! }));
    const manager = f.createProcess({ reconcileLaunch: reconcile, recordStopped: lifecycle.recordStoppedControllerGeneration }, 3, leases);
    f.launch.mockClear(); confirm.mockClear();
    if (kind === "valid") { await manager.advance(f.current(), signal); expect(f.current().intent!.executionGeneration).toBe("2"); expect(f.launch).toHaveBeenCalledOnce(); }
    else { await expect(manager.advance(f.current(), signal)).rejects.toThrow(); expect(f.current().intent!.executionGeneration).toBe("1"); expect(f.launch).not.toHaveBeenCalled(); }
    expect(confirm).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); }
});
