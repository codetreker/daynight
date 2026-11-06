import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";
import { BotEnvironmentCleanupError } from "../../../src/commands/worker/bots/environment.js";
import { BotCliProbeCleanupError } from "../../../src/commands/worker/bots/cli-probe.js";
import { ControllerStartupError } from "../../../src/commands/controller/startup.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { cleanupBotProcesses, fixture, id } from "./bot-process.fixtures.js";

afterEach(cleanupBotProcesses);

test.each(["codex","claude","copilot"] as const)("launches %s in an ordinary cwd with a persisted role and no user turn",async provider=>{
  const f=fixture(provider); const snapshot=await f.process.advance(f.current(),new AbortController().signal);
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
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown"); f.observe.mockRejectedValueOnce(new Error("IPC unavailable"));
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow(/IPC.*unavailable/);
  await f.createProcess().advance(f.current(),new AbortController().signal); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1);
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

const recoveryFixture = async () => {
  const f = fixture(), signal = new AbortController().signal;
  const proof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64) };
  await f.process.advance(f.current(), signal);
  let saved: ControllerSnapshot = { ...f.executions.get(f.current())!.snapshot!, controllerProcess: proof };
  f.executions.update(f.current(), { snapshot: saved });
  const confirmStopped = vi.fn(async () => false);
  const stopProcesses = vi.fn(async () => { confirmStopped.mockResolvedValue(true); });
  const request = vi.fn(async () => ({ snapshot: saved }));
  const recordStopped = vi.fn(async () => (saved = { ...saved, lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-05T00:00:00Z" }));
  f.observe.mockImplementation(async () => { if (saved.nativeStopped) throw new Error("IPC unavailable"); return saved; });
  const deps = { confirmStopped, stopProcesses, request, recordStopped, readSnapshot: () => saved };
  return { ...f, signal, deps, manager: f.createProcess(deps), saved: () => saved,
    patch: (patch: Partial<ControllerSnapshot>) => { saved = { ...saved, ...patch } as ControllerSnapshot; },
    restart: () => f.createProcess(deps) };
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

test("reattaching a surviving writer cancels stale orderly-stop provenance before a later crash", async () => {
  const f = await recoveryFixture();
  f.deps.stopProcesses.mockRejectedValueOnce(new Error("stop failed"));
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow("stop failed");
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(false);
  f.observe.mockRejectedValue(new Error("IPC disappeared")); f.deps.confirmStopped.mockResolvedValue(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(1);
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
  f.deps.stopProcesses.mockClear();
  f.deps.recordStopped.mockRejectedValueOnce(new Error("Original controller stop evidence is unavailable"));
  await expect(f.restart().shutdown(f.current(), f.signal)).rejects.toThrow(/stop evidence is unavailable/);
  expect(f.deps.stopProcesses).toHaveBeenCalledWith(nextProof, [], expect.any(Number));
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
  await expect(f.process.withDeletion(record, signal, stop => stop())).rejects.toThrow(/process proof/);
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
