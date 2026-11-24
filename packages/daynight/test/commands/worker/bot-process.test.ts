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
import * as launchTickets from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { ControllerBootstrapReplacedError, ControllerLaunchJournalConflictError, ControllerLaunchJournalObservationError, type reconcileSubmittedControllerLaunch } from "../../../src/commands/controller/launch-observation.js";
import { cleanupBotProcesses, fixture, id } from "./bot-process.fixtures.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import * as storageLock from "../../../src/commands/controller/storage-lock.js";
import { ControllerStorageWaitingError } from "../../../src/commands/controller/storage-preparation.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { writeUnreleasedLaunch } from "../../../src/commands/controller/unreleased-launch.js";
import { hasNeverStartedDeletionEvidence } from "../../../src/commands/worker/bots/execution-store.js";

afterEach(cleanupBotProcesses);

test("settles a persisted unreleased Bot after restart without replaying its ticket", async () => {
  const f = fixture("codex", {}, true), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting();
    await options.onSpawned({ kind: "linux-controller-launch", pid: 123, launchId: options.ticket.launchId });
    await writeUnreleasedLaunch(f.home, options.ticket, 123);
    throw new Error("launch gate failed");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("launch gate failed");
  f.reopen();
  const restarted = f.createProcess();
  await expect(restarted.advance(f.current(), signal)).rejects.toThrow(/confirmed unreleased/);
  expect(f.executions.get(f.current())?.unreleased).toMatchObject({ kind: "controller-unreleased", pid: 123 });
  expect(f.launch).toHaveBeenCalledOnce();
  const deleting = markDeleting(f);
  const stop = await restarted.withDeletion(deleting, signal, stop => stop());
  expect(stop).toMatchObject({ stopProof: { kind: "never_started" } });
  const prepared = f.store.prepareDeletion(deleting, stop, []);
  expect(hasNeverStartedDeletionEvidence(prepared, f.executions.get(prepared))).toBe(true);
});

test("rejects an unreleased receipt with a conflicting saved PID", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting();
    await options.onSpawned({ kind: "linux-controller-launch", pid: 123, launchId: options.ticket.launchId });
    await writeUnreleasedLaunch(f.home, options.ticket, 124);
    throw new Error("launch gate failed");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("launch gate failed");
  await expect(f.process.shutdown(f.current(), signal)).rejects.toThrow(/conflicts with saved process/);
  expect(f.executions.get(f.current())?.unreleased).toBeUndefined();
});

test("an authenticated Controller conflicts with an unreleased receipt", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting(); await writeUnreleasedLaunch(f.home, options.ticket, 123);
    throw new Error("launch gate failed");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("launch gate failed");
  const request = vi.fn(async () => ({ snapshot: await f.observe(await f.process.readTicket(f.current())) }));
  await expect(f.createProcess({ request }).shutdown(f.current(), signal)).rejects.toThrow(/authenticated Controller IPC/);
  expect(f.executions.get(f.current())?.unreleased).toBeUndefined();
});

test("an unknown IPC outcome cannot settle an unreleased receipt", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting(); await writeUnreleasedLaunch(f.home, options.ticket, 123);
    throw new Error("launch gate failed");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("launch gate failed");
  const request = vi.fn(async () => { throw new ControllerIpcOutcomeUnknownError("observation timed out"); });
  await expect(f.createProcess({ request }).shutdown(f.current(), signal)).rejects.toThrow("observation timed out");
  expect(f.executions.get(f.current())?.unreleased).toBeUndefined();
});

test("a current journal row conflicts with an unreleased receipt", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting(); await writeUnreleasedLaunch(f.home, options.ticket, 123);
    throw new Error("launch gate failed");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("launch gate failed");
  const ticket = await f.process.readTicket(f.current());
  const read = vi.spyOn(lifecycle, "readCurrentControllerInventorySnapshot").mockReturnValue({ ticket, snapshot: await f.observe(ticket) });
  try {
    await expect(f.process.shutdown(f.current(), signal)).rejects.toThrow(/current journal/);
    expect(f.executions.get(f.current())?.unreleased).toBeUndefined();
  } finally { read.mockRestore(); }
});

test("a ticket-bound stopped Linux generation does not recheck its reused PID", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    const proof = { kind: "linux-controller-launch" as const, pid: 123, launchId: options.ticket.launchId };
    await options.onSubmitting(); await options.onSpawned(proof);
    const snapshot = { ...await f.observe(options.ticket), controllerProcess: proof };
    await options.onObserved(snapshot); return snapshot;
  });
  await f.process.advance(f.current(), signal);
  const saved = f.executions.get(f.current())!.snapshot!;
  const stopped = { ...saved, lifecycle: "stopped" as const, activity: "stopped" as const, nativeStopped: true, stoppedAt: new Date().toISOString() };
  const read = vi.spyOn(lifecycle, "readHistoricalStoppedControllerGeneration").mockReturnValue(stopped);
  const reconcileLaunch = vi.fn(async () => { throw new Error("reused PID must not be observed"); });
  const stopProcesses = vi.fn(async () => { throw new Error("reused PID must not be stopped"); });
  try {
    await f.createProcess({ reconcileLaunch, stopProcesses }).shutdown(f.current(), signal);
    expect(f.executions.get(f.current())?.snapshot).toEqual(stopped);
    expect(reconcileLaunch).not.toHaveBeenCalled(); expect(stopProcesses).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

test("ordinary shutdown retains failed preflight cleanup until the original probe and aliases close", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const alias = path.join(f.home, "state", "agent-cli-aliases", "scope-probe");
  mkdirSync(alias, { recursive: true }); writeFileSync(path.join(alias, "daynight"), "private shim");
  const retryCleanup = vi.fn(async () => {}).mockRejectedValueOnce(new Error("original probe still running"));
  const failure = new BotEnvironmentCleanupError(alias, new BotCliProbeCleanupError({ launchId: id(95), pid: null, process: null, jobObjectName: null, targetStarted: false }, retryCleanup));
  const manager = f.createProcess({ prepareEnvironment: async () => { throw failure; } });
  await expect(manager.advance(f.current(), signal)).rejects.toBe(failure);
  expect(f.current().intent).toBeNull();
  await expect(manager.shutdown(f.current(), signal)).rejects.toThrow("original probe still running");
  await expect(manager.close()).rejects.toThrow("preparation cleanup remains unconfirmed");
  expect(existsSync(alias)).toBe(true);
  await manager.shutdown(f.current(), signal); await manager.close();
  expect(existsSync(alias)).toBe(false);
  expect(retryCleanup).toHaveBeenCalledTimes(2);
  expect(f.register).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});

test("ordinary shutdown retries retained aliases for a never-submitted execution without changing its identity", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.grant.mockRejectedValueOnce(new Error("grant denied"));
  f.release.mockRejectedValueOnce(new Error("alias removal denied"));
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("alias removal denied");
  const original = f.current().intent, execution = f.executions.get(f.current());
  expect(execution?.launchSubmission).toBe("not-submitted");
  await expect(f.process.close()).rejects.toThrow("preparation cleanup remains unconfirmed");
  await f.process.shutdown(f.current(), signal); await f.process.close();
  expect(f.current().intent).toEqual(original);
  expect(f.executions.get(f.current())).toEqual(execution);
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.launch).not.toHaveBeenCalled();
});

test.each(["codex","claude","copilot"] as const)("launches %s in an ordinary cwd with a persisted role and no user turn",async provider=>{
  const f=fixture(provider); const snapshot=await f.process.advance(f.current(),new AbortController().signal);
  expect(f.prepareEnvironment).toHaveBeenCalledWith(expect.objectContaining({ botId: f.current().botId, workerPaths: resolveConfigurationPaths(f.home) }));
  expect(snapshot.lifecycle).toBe("ready"); expect(f.getTicket()).toMatchObject({provider,cwd:f.home,initialInput:"none",initialPrompt:"",instructions:f.current().intent!.roleConfiguration!.instructions,resumeNativeSessionId:null});
  expect(f.getTicket()).not.toHaveProperty("claimId"); expect(f.getTicket()).not.toHaveProperty("workerId"); expect(f.getTicket().configuration.agentControlMode).toBe("web");
  expect(f.getTicket()).not.toHaveProperty("codexBotRecovery");
  expect(f.getTicket()).not.toHaveProperty("claudeBotRecovery");
  expect(f.getTicket()).not.toHaveProperty("copilotBotRecovery");
  expect(existsSync(path.join(f.home,".git"))).toBe(false); expect(f.executions.get(f.current())!.launchSubmission).toBe("acknowledged"); expect(f.release).not.toHaveBeenCalled();
  await f.process.advance(f.current(),new AbortController().signal); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1); expect(f.prepareEnvironment).toHaveBeenCalledTimes(1);
});

test.each(["codex", "claude", "copilot"] as const)("binds dedicated recovery only for a new supported Bot storage profile (%s)", async provider => {
  const f = fixture(provider, {}, false, true);
  await f.process.advance(f.current(), new AbortController().signal);
  if (provider === "codex") {
    expect(f.getTicket().codexBotRecovery).toEqual({ botId: f.current().botId,
      directory: resolveBotPaths(resolveConfigurationPaths(f.home).stateDirectory, f.current().botId).codexRecoveryDirectory });
    expect(f.getTicket().nativeHome).toBe("/real/codex");
  } else expect(f.getTicket()).not.toHaveProperty("codexBotRecovery");
  if (provider === "claude") {
    expect(f.getTicket().claudeBotRecovery).toEqual({ botId: f.current().botId,
      directory: resolveBotPaths(resolveConfigurationPaths(f.home).stateDirectory, f.current().botId).claudeRecoveryDirectory });
    expect(f.getTicket().nativeHome).toBe(path.join(f.home, ".claude"));
  } else expect(f.getTicket()).not.toHaveProperty("claudeBotRecovery");
  if (provider === "copilot") {
    expect(f.getTicket().copilotBotRecovery).toEqual({ botId: f.current().botId,
      directory: resolveBotPaths(resolveConfigurationPaths(f.home).stateDirectory, f.current().botId).copilotRecoveryDirectory });
  } else expect(f.getTicket()).not.toHaveProperty("copilotBotRecovery");
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
  expect(f.observe).not.toHaveBeenCalled();
  writeFileSync(f.getTicket().credentialFile,JSON.stringify({expiresAt:new Date(Date.now()+60000).toISOString()}));
  await f.process.refreshGrant(f.current(),signal);expect(f.grant).toHaveBeenCalledTimes(2);
  expect(f.observe).toHaveBeenCalledOnce();
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

const recoveryFixture = async (configuration: Partial<BotConfiguration> = {}, unacknowledged = false, starting = false, recoveryLimit = 3, dedicated = false, provider: "codex" | "claude" | "copilot" = "codex", persistent = false) => {
  const f = fixture(provider, configuration, persistent, dedicated), signal = new AbortController().signal;
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

test("an unreleased recovery keeps the previous native session and never replays its ticket", async () => {
  const f = await recoveryFixture();
  await f.manager.shutdown(f.current(), f.signal);
  const previousTicket = await f.manager.readTicket(f.current()), previousStopped = f.executions.get(f.current())!.snapshot!;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting(); await options.onSpawned({ kind: "linux-controller-launch", pid: 321, launchId: options.ticket.launchId });
    await writeUnreleasedLaunch(f.home, options.ticket, 321);
    throw new Error("recovery launch gate failed");
  });
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow("recovery launch gate failed");
  const intent = f.current().intent!;
  expect(intent).toMatchObject({ executionGeneration: "2", nativeSessionId: previousStopped.nativeSessionId });
  const read = vi.spyOn(lifecycle, "readCurrentControllerInventorySnapshot").mockReturnValue({ ticket: previousTicket, snapshot: previousStopped });
  const request = vi.fn(async () => { throw new ControllerIpcOutcomeUnknownError("socket absent", { cause: Object.assign(new Error("absent"), { code: "ENOENT" }) }); });
  try {
    const restarted = f.createProcess({ ...f.deps, request });
    await expect(restarted.advance(f.current(), f.signal)).rejects.toThrow(/confirmed unreleased/);
    expect(f.current().intent).toEqual(intent);
    expect(f.executions.get(f.current())?.unreleased).toMatchObject({ pid: 321 });
    expect(f.launch).toHaveBeenCalledTimes(2);
    const deleting = markDeleting(f);
    await expect(restarted.withDeletion(deleting, f.signal, stop => stop())).rejects.toThrow(/generation is unconfirmed/);
  } finally { read.mockRestore(); }
});

test("refreshes authenticated IPC before renewing a credential from a cached starting snapshot", async () => {
  const f = await recoveryFixture({}, false, true);
  expect(f.executions.get(f.current())!.snapshot).toMatchObject({ lifecycle: "starting", nativeSessionId: null });
  f.patch({ lifecycle: "ready", nativeSessionId: id(9), startup: { state: "ready", reasonCode: "ready" } });
  writeFileSync(f.current().intent!.credentialFile, JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await f.manager.refreshGrant(f.current(), f.signal);
  expect(f.grant).toHaveBeenCalledTimes(2);
  expect(f.grant.mock.calls[1]![0].intent!.nativeSessionId).toBe(id(9));
  expect(f.executions.get(f.current())!.snapshot).toMatchObject({ lifecycle: "ready", nativeSessionId: id(9) });
  expect(f.current().intent!.nativeSessionId).toBeNull();
  expect(f.launch).toHaveBeenCalledOnce();
});

test("renews a ready lazy Provider before its native Session exists", async () => {
  const f = await recoveryFixture({}, false, true, 3, false, "copilot");
  f.patch({ lifecycle: "ready", nativeSessionId: null, startup: { state: "ready", reasonCode: "ready" } });
  writeFileSync(f.current().intent!.credentialFile, JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await f.manager.refreshGrant(f.current(), f.signal);
  expect(f.grant).toHaveBeenCalledTimes(2);
  expect(f.grant.mock.calls[1]![0].intent!.nativeSessionId).toBeNull();
  expect(f.executions.get(f.current())!.snapshot).toMatchObject({ lifecycle: "ready", nativeSessionId: null });
});

test("does not renew after failed IPC authentication or a newly observed stopped Controller", async () => {
  const f = await recoveryFixture({}, false, true);
  writeFileSync(f.current().intent!.credentialFile, JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const conflict = new ControllerIpcIdentityConflictError("Controller fence differs");
  f.observe.mockRejectedValueOnce(conflict);
  await expect(f.manager.refreshGrant(f.current(), f.signal)).rejects.toBe(conflict);
  expect(f.grant).toHaveBeenCalledOnce();
  f.observe.mockResolvedValueOnce({ ...f.saved(), lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() });
  await f.manager.refreshGrant(f.current(), f.signal);
  expect(f.grant).toHaveBeenCalledOnce();
  expect(f.executions.get(f.current())!.snapshot).toMatchObject({ lifecycle: "stopped", nativeStopped: true });
});

test("shutdown retains Bot artifacts and restart resumes the original native session with a new generation", async () => {
  const f = await recoveryFixture(), original = f.current().intent!;
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.executions.get(f.current())).toMatchObject({ restartAfterShutdown: true, recoveryCount: 0, snapshot: { nativeStopped: true } });
  expect(existsSync(original.ticketPath)).toBe(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.getTicket()).toMatchObject({ executionGeneration: "2", sessionId: original.sessionId, testExecutionId: original.executionId, resumeNativeSessionId: id(9), instructions: original.roleConfiguration!.instructions, initialInput: "none", initialPrompt: "" });
  expect(f.getTicket()).not.toHaveProperty("codexBotRecovery");
  expect(f.current().intent!.registration).toEqual(original.registration);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.grant.mock.calls.at(-1)).toHaveLength(3);
});

test.each(["codex", "claude", "copilot"] as const)("a dedicated %s Bot recovery retains its original binding and shared configuration home", async provider => {
  const f = await recoveryFixture({}, false, false, 3, true, provider), first = f.getTicket();
  const field = `${provider}BotRecovery` as const;
  expect(first[field]).toBeDefined();
  await f.manager.shutdown(f.current(), f.signal);
  await f.restart().advance(f.current(), f.signal);
  expect(f.getTicket()).toMatchObject({ [field]: first[field], nativeHome: first.nativeHome,
    executionGeneration: "2", sessionId: first.sessionId, resumeNativeSessionId: id(9) });
  expect(f.register).toHaveBeenCalledTimes(1);
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

test("a new host reauthorizes an authenticated working Controller without replaying its turn", async () => {
  const f = await recoveryFixture(), original = f.current().intent!;
  f.patch({ lifecycle: "working", activity: "working", currentTurnId: id(91) });
  const host = f.createProcess(f.deps, 3, undefined, () => true);
  await expect(host.advance(f.current(), f.signal)).resolves.toMatchObject({ currentTurnId: id(91), lifecycle: "working" });
  expect(f.grant).toHaveBeenCalledTimes(2);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.deps.stopProcesses).not.toHaveBeenCalled();
  expect(f.deps.request).not.toHaveBeenCalled();
  expect(f.current().intent).toEqual(original);
});

test("refused hosting authorization preserves the live Controller and its original generation", async () => {
  const f = await recoveryFixture(), original = f.current().intent!;
  f.grant.mockRejectedValueOnce(new Error("resource_conflict"));
  const host = f.createProcess(f.deps, 3, undefined, () => true);
  await expect(host.advance(f.current(), f.signal)).rejects.toThrow("resource_conflict");
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.deps.stopProcesses).not.toHaveBeenCalled();
  expect(f.current().intent).toEqual(original);
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

test("Bot recovery retains its original generation and recovery allowance while readers remain", async () => {
  const reason = "reader_busy" as const;
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  const original = f.current().intent!, cause = new Error("Storage preparation is waiting.");
  f.prepareStorage.mockReturnValueOnce({ kind: "waiting", reason, cause });
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toMatchObject({ reason, cause });
  expect(f.current().intent).toEqual(original);
  expect(f.executions.get(f.current())).toMatchObject({ recoveryCount: 0, snapshot: { lifecycle: "stopped", nativeStopped: true } });
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.prepareStorage).toHaveBeenCalledWith({ journalFile: original.journalPath, mode: "stopped-maintenance", ticket: expect.objectContaining({ launchId: original.launchId }) }, expect.objectContaining({ journalFile: original.journalPath }));
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

test("a lost execution row cannot turn a retained launch intent into never-started proof", async () => {
  const f = fixture("codex", {}, true), signal = new AbortController().signal;
  await f.process.advance(f.current(), signal);
  const database = new Database(path.join(f.home, "worker.sqlite"));
  try { database.prepare("DELETE FROM bot_executions").run(); } finally { database.close(); }
  const record = markDeleting(f);
  let cleaned = false;
  await expect(f.process.withDeletion(record, signal, async stop => { await stop(); cleaned = true; })).rejects.toThrow("execution_evidence_missing");
  expect(cleaned).toBe(false); expect(existsSync(record.intent!.ticketPath)).toBe(true);
  expect(f.current().intent).toEqual(record.intent);
});

const journalOnlyDeletion = async () => {
  const f = await recoveryFixture({}, false, false, 3, false, "codex", true);
  const database = new Database(path.join(f.home, "worker.sqlite"));
  try { database.prepare("DELETE FROM bot_executions").run(); } finally { database.close(); }
  const deleting = markDeleting(f), observed = deleting.observed;
  if (observed.deletion === null) throw new Error("Expected deletion fixture");
  const record = f.store.observe(f.owner, { ...observed, version: String(BigInt(observed.version) + 1n),
    deletion: { ...observed.deletion, workerCleanup: { state: "failed", code: "execution_evidence_missing" } } }, 3);
  return { ...f, record };
};

test("explicit journal-only deletion stops its original generation without reconstructing execution or cleanup", async () => {
  const f = await journalOnlyDeletion(), read = vi.spyOn(lifecycle, "readCurrentControllerSnapshot").mockImplementation(() => f.saved());
  try {
    const stop = () => f.manager.withDeletion(f.record, f.signal, stop => stop({ recoverMissingExecution: true }));
    expect(await stop()).toMatchObject({ sessionId: f.record.intent!.sessionId, stopProof: { stoppedAt: "2026-11-05T00:00:00Z" } });
    expect(f.deps.stopProcesses).toHaveBeenCalledOnce(); expect(f.deps.recordStopped).toHaveBeenCalledOnce();
    expect(await stop()).toMatchObject({ stopProof: { stoppedAt: "2026-11-05T00:00:00Z" } });
    expect(f.deps.stopProcesses).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(f.record.intent!.journalPath, f.getTicket(), expect.any(Number));
    expect(f.executions.get(f.record)).toBeNull(); expect(f.current().cleanup).toBeUndefined();
    expect(f.current().intent).toEqual(f.record.intent); expect(existsSync(f.record.intent!.ticketPath)).toBe(true);
    expect(f.current().observed.deletion?.workerCleanup).toEqual({ state: "failed", code: "execution_evidence_missing" });
    expect(f.launch).toHaveBeenCalledOnce(); expect(f.deps.request).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

test.each(["ticket", "journal"])("journal-only deletion rejects a conflicting %s before stopping", async kind => {
  const f = await journalOnlyDeletion(), read = vi.spyOn(lifecycle, "readCurrentControllerSnapshot").mockImplementation(() => f.saved());
  const ticket = kind === "ticket" ? vi.spyOn(launchTickets, "readLaunchTicket").mockResolvedValue({ ...f.getTicket(), controllerInstanceId: id(99) }) : undefined;
  if (kind === "journal") f.patch({ controllerInstanceId: id(99) });
  try {
    await expect(f.manager.withDeletion(f.record, f.signal, stop => stop({ recoverMissingExecution: true }))).rejects.toThrow(/original|fence/);
    expect(f.deps.stopProcesses).not.toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
    expect(f.executions.get(f.record)).toBeNull(); expect(f.current().cleanup).toBeUndefined();
  } finally { ticket?.mockRestore(); read.mockRestore(); }
});

test("journal-only deletion refuses an unavailable Windows Job identity before termination", async () => {
  const f = await journalOnlyDeletion(), read = vi.spyOn(lifecycle, "readCurrentControllerSnapshot").mockImplementation(() => f.saved());
  const leases = { enabled: true, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => {},
    retain: vi.fn(async () => { throw new Error("Windows original Job identity unavailable"); }), get: async () => undefined, release: vi.fn(async () => {}), close: async () => {} };
  try {
    await expect(f.createProcess(f.deps, 0, leases).withDeletion(f.record, f.signal, stop => stop({ recoverMissingExecution: true }))).rejects.toThrow("Windows original Job identity unavailable");
    expect(leases.retain).toHaveBeenCalledWith(f.record.intent!.launchId, f.saved().controllerProcess, expect.any(Number));
    expect(f.deps.stopProcesses).not.toHaveBeenCalled(); expect(f.deps.recordStopped).not.toHaveBeenCalled();
    expect(f.current().cleanup).toBeUndefined(); expect(f.executions.get(f.record)).toBeNull();
  } finally { read.mockRestore(); }
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
  expect(f.release).toHaveBeenCalledOnce(); await f.process.close();
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

test.skipIf(process.platform !== "linux")("Bot uses retained Linux launch and native proof on journal I/O failure", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    const proof = { kind: "linux-controller-launch" as const, pid: 123, launchId: options.ticket.launchId };
    await options.onSubmitting(); await options.onSpawned(proof);
    const snapshot = { ...await f.observe(options.ticket), controllerProcess: proof };
    await options.onObserved(snapshot); return snapshot;
  });
  await f.process.advance(f.current(), signal);
  const saved = f.executions.get(f.current())!.snapshot!;
  const ipc = new ControllerIpcOutcomeUnknownError("IPC unavailable");
  const io = () => new ControllerLaunchJournalObservationError(ipc, Object.assign(new Error("journal I/O"), { code: "EIO" }));
  const reconcileLaunch = vi.fn().mockRejectedValueOnce(io()).mockRejectedValueOnce(io());
  const stopBootstrap = vi.fn(async () => {}), stopProcesses = vi.fn(async () => {}), confirmStopped = vi.fn(async () => true);
  const read = vi.spyOn(lifecycle, "readHistoricalStoppedControllerGeneration").mockReturnValue(null);
  try {
    await expect(f.createProcess({ reconcileLaunch, stopBootstrap, stopProcesses, confirmStopped }).shutdown(f.current(), signal)).rejects.toThrow();
    expect(stopProcesses).toHaveBeenCalledWith(saved.controllerProcess, saved.nativeProcesses, expect.any(Number));
    expect(confirmStopped).toHaveBeenCalledWith(saved.controllerProcess, saved.nativeProcesses, expect.any(Number));
    expect(f.release).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
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
  const leases = { enabled: true, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: vi.fn(async () => lease), get: vi.fn(async () => lease), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const manager = f.createProcess(f.deps, 3, leases), failure = new Error("stop response failed");
  f.deps.request.mockRejectedValueOnce(failure);
  await expect(manager.shutdown(f.current(), f.signal)).rejects.toBe(failure);
  expect(leases.retain).toHaveBeenCalledBefore(f.deps.request); expect(leases.retain).toHaveBeenCalledBefore(f.deps.stopBootstrap);
  const deadline = (f.deps.stopBootstrap.mock.calls[0]! as unknown as [unknown, number])[1];
  expect(f.deps.stopProcesses).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, deadline, lease);
  expect(f.deps.confirmStopped).toHaveBeenCalledWith(f.saved().controllerProcess, f.saved().nativeProcesses, deadline, lease);
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(leases.release).not.toHaveBeenCalled();
  await manager.shutdown(f.current(), f.signal);
  expect(f.deps.recordStopped).toHaveBeenCalledWith(f.current().intent!.journalPath, expect.anything(), { deadline: expect.any(Number), jobLease: lease });
  expect(leases.release).toHaveBeenCalledOnce();
});

test("Bot still stops its bootstrap if original Job acquisition fails", async () => {
  const f = await recoveryFixture(), failure = new Error("Job identity unavailable"), incomplete = new Error("Job lease required");
  const leases = { enabled: true, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: vi.fn(async () => { throw failure; }), get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
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
    const stopped = await lifecycle.recordStoppedControllerGeneration(file, ticket, { deadline: Date.now() + 5000, jobLease: {} as never });
    f.executions.update(f.current(), { snapshot: stopped }); f.reopen();
    if (kind !== "valid") {
      const db = new Database(file), row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }, value = JSON.parse(row.snapshot);
      if (kind === "missing") delete value.windowsJobStopProof;
      if (kind === "generation") value.executionGeneration = "2";
      if (kind === "process") value.controllerProcess.commandHash = "b".repeat(64);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); db.close();
    }
    const leases = { enabled: true, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: vi.fn(async () => undefined), get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const reconcile = vi.fn<typeof reconcileSubmittedControllerLaunch>(async ({ spawnProof }) => ({ kind: "controller-exited", process: spawnProof, snapshot: lifecycle.readControllerSnapshot(file)! }));
    const manager = f.createProcess({ reconcileLaunch: reconcile, recordStopped: lifecycle.recordStoppedControllerGeneration }, 3, leases);
    f.launch.mockClear(); confirm.mockClear();
    if (kind === "valid") { await manager.advance(f.current(), signal); expect(f.current().intent!.executionGeneration).toBe("2"); expect(f.launch).toHaveBeenCalledOnce(); }
    else { await expect(manager.advance(f.current(), signal)).rejects.toThrow(); expect(f.current().intent!.executionGeneration).toBe("1"); expect(f.launch).not.toHaveBeenCalled(); }
    expect(confirm).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); }
});
