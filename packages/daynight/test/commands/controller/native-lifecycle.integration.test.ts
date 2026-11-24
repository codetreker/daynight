import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import { freezeNativeLifecycleFence } from "../../../src/commands/controller/native-lifecycle.js";
import { inspectBootstrapProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { startCopilotProcess } from "../../../src/commands/controller/providers/copilot-owned-process.js";
import { assertNativeLifecycleAdmission } from "../../../src/commands/controller/native-lifecycle.js";

// These helpers execute their production IPC and native subprocess boundaries.
const { queryClaudeLive } = await import(new URL("../../../dist/commands/controller/providers/claude-live.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude-live.js");
const { startCopilotRuntime } = await import(new URL("../../../dist/commands/controller/providers/copilot-runtime.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/copilot-runtime.js");
const cleanups: (() => Promise<void>)[] = [];
const settleCleanups = async (actions: (() => Promise<void>)[]) => {
  const failures: unknown[] = [];
  for (const action of actions) try { await action(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed.");
};
afterEach(async () => { await settleCleanups(cleanups.splice(0).reverse()); });

const bounded = async <T>(promise: Promise<T>, deadline: number, label: string): Promise<T> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded the cleanup deadline.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded the cleanup deadline.`)), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};

const waitForNativeStop = async (proof: ProcessProof, deadline: number, stop: (pid: number) => void = () => {}, observe = inspectBootstrapProcessProof) => {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Native process stop exceeded the cleanup deadline.");
    const state = await observe(proof, Math.min(remaining, 5000));
    if (state === "stopped") return;
    if (state === "replaced") throw new Error("Native process identity was replaced before stop was observed.");
    if (state === "running") stop(proof.pid);
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
};

type ClaudeCleanup = {
  join: () => Promise<void>;
  pump: Promise<void>;
  proofs: ProcessProof[];
  subscribe: (listener: (proof: ProcessProof) => void) => () => void;
  child: () => ChildProcess | undefined;
  close: () => Promise<void> | undefined;
  stop: (pid: number) => void;
  restoreDisconnect: () => void;
  observe?: typeof inspectBootstrapProcessProof;
  expectedJoin?: (error: unknown) => boolean;
  expectedPump?: (error: unknown) => boolean;
};

const cleanupClaude = async (owner: ClaudeCleanup, deadline: number) => {
  const failures: unknown[] = [], pending = new Set<Promise<void>>(), seen = new Set<ProcessProof>();
  let wake: (() => void) | undefined, joinDone = false, joinRejected = false, helperClosed = false;
  const changed = () => { wake?.(); wake = undefined; };
  const observe = (proof: ProcessProof) => {
    if (seen.has(proof)) return;
    // This fixture uses SDK 0.3.247's ordinary query without resume or a
    // session store. That path constructs one transport and spawns it once.
    if (seen.size) failures.push(new Error("Claude fixture produced more than one native process proof."));
    seen.add(proof);
    const operation = waitForNativeStop(proof, deadline, owner.stop, owner.observe).catch(error => { failures.push(error); });
    pending.add(operation);
    void operation.finally(() => { pending.delete(operation); changed(); });
    changed();
  };
  // Register rejection handling before any other asynchronous cleanup work.
  const join = owner.join();
  void join.then(() => { joinDone = true; changed(); }, () => { joinRejected = true; joinDone = true; changed(); });
  const unsubscribe = owner.subscribe(observe);
  for (const proof of owner.proofs) observe(proof);
  let watchedClose: Promise<void> | undefined;
  const watchClose = () => {
    const close = owner.close();
    if (close && close !== watchedClose) {
      watchedClose = close;
      void close.then(() => { helperClosed = true; changed(); }, changed);
    }
  };
  try {
    // Reserve part of the existing budget for forced helper close and drains.
    const cutoff = deadline - Math.min(1000, Math.floor(Math.max(0, deadline - Date.now()) / 5));
    try {
      for (;;) {
        watchClose();
        // A failed join can precede its native birth receipt. Keep the helper
        // alive until the original proof is observed or the helper closes.
        if (joinDone && !pending.size && (!joinRejected || seen.size > 0 || helperClosed)) break;
        await bounded(new Promise<void>(resolve => { wake = resolve; }), cutoff, "Claude cooperative cleanup");
      }
    } catch (error) { failures.push(error); }
    owner.restoreDisconnect();
    const child = owner.child();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch (error) { failures.push(error); }
    }
    const close = owner.close();
    const drains = await Promise.allSettled([
      ...(close ? [bounded(close, deadline, "Claude helper close")] : []),
      bounded(pumpHandled(owner.pump), deadline, "Claude pump"),
      bounded(pumpHandled(join), deadline, "Claude join"),
    ]);
    // No new proof can arrive after confirmed helper close. Settle proofs that
    // arrived while the join, helper and provider pump were draining.
    while (pending.size) {
      try { await bounded(Promise.all([...pending]), deadline, "Native process drain"); }
      catch (error) { failures.push(error); break; }
    }
    const pumpIndex = close ? 1 : 0, joinIndex = pumpIndex + 1;
    for (const [index, result] of drains.entries()) {
      if (result.status === "rejected") { failures.push(result.reason); continue; }
      if (index === pumpIndex || index === joinIndex) {
        const outcome = result.value as PromiseSettledResult<void>;
        if (outcome.status === "rejected" && !(index === pumpIndex ? owner.expectedPump?.(outcome.reason) : owner.expectedJoin?.(outcome.reason))) failures.push(outcome.reason);
      }
    }
  } finally { unsubscribe(); }
  if (failures.length) throw new AggregateError(failures, `Claude fixture cleanup failed: ${failures.map(String).join("; ")}`);
};

const pumpHandled = (promise: Promise<void>): Promise<PromiseSettledResult<void>> => promise.then(
  () => ({ status: "fulfilled", value: undefined }),
  reason => ({ status: "rejected", reason }),
);
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/native-lifecycle"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), file = path.join(root, "lifecycle.sqlite");
  const identity = { serverOrigin: "https://daynight.example", userId: randomUUID(), workerId: randomUUID() };
  const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), localEpoch: "1", intentVersion: "1", scopeGeneration: "1" };
  const store = openLifecycleStore({ file, identity, allowCreate: true });
  store.bindInstance({ ...binding, desired: "enabled" }); store.markStopped({ localEpoch: "1", inventoryRevision: store.readState().inventoryRevision });
  const activation = { binding, action: "bootstrap" as const, operationId: randomUUID() };
  store.prepareActivation(activation); store.commitActivation({ ...activation, receipt: { protocolVersion: 1, action: "bootstrap", admission: "open", operationId: activation.operationId, workerId: identity.workerId, instanceId: binding.instanceId, localEpoch: "1", intentVersion: "1", scopeGeneration: "1" } });
  cleanups.push(() => settleCleanups([async () => { store.close(); }, () => rm(root, { recursive: true, force: true })]));
  return { root, store, fence: freezeNativeLifecycleFence({ file, binding }), disable: () => store.closeAdmission({ operationId: randomUUID(), local: true }) };
};
const claude = async (value: Awaited<ReturnType<typeof fixture>>, onBirth?: () => void, admissionFailure = false) => {
  const log = path.join(value.root, "native.jsonl"), probe = path.join(value.root, "version-probe"), executable = path.join(value.root, "native.mjs"), sessionId = randomUUID();
  const token = randomUUID(), sockets = new Set<Socket>(), controls = new Map<number, Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString();
      if (data.length > 200) { socket.destroy(); return; }
      if (!data.endsWith("\n")) return;
      const [received, pid] = data.trim().split(":");
      if (received !== token || !/^\d+$/.test(pid ?? "")) { socket.destroy(); return; }
      controls.set(Number(pid), socket); socket.removeAllListeners("data");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native fixture control listener has no port.");
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  await writeFile(executable, `import { writeFileSync } from 'node:fs';import { connect } from 'node:net';if(process.argv.includes('--version'))writeFileSync(${JSON.stringify(probe)},'started');else {const control=connect(${address.port},'127.0.0.1',()=>control.write(${JSON.stringify(token + ":")}+process.pid+'\\n'));control.on('data',()=>process.exit(0));control.on('error',()=>{});control.unref();}await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "fixtures/claude-live-native.mjs")).href)});`);
  const env = { ...process.env, HOME: value.root, USERPROFILE: value.root, CLAUDE_CONFIG_DIR: value.root, DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log };
  let child: ChildProcess | undefined, childClose: Promise<void> | undefined, restoreDisconnect: (() => void) | undefined; const proofs: ProcessProof[] = [];
  const proofListeners = new Set<(proof: ProcessProof) => void>();
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: value.root, sessionId, settingSources: [], pathToClaudeCodeExecutable: executable, env } }, {
    cwd: value.root, model: null, args: [], resumeNativeSessionId: null, env, nativeLifecycleFence: value.fence,
    // No parent assertion: the helper must independently reject the native call.
    onSpawn: process => {
      child = process; childClose = new Promise(resolve => process.once("close", () => resolve()));
      // Let the helper close its end of IPC so Node observes the channel close.
      const disconnect = process.disconnect;
      restoreDisconnect = () => { process.disconnect = disconnect; };
      process.disconnect = () => {
        restoreDisconnect?.();
        if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
        else if (process.connected) disconnect.call(process);
        return process;
      };
    }, onNativeProcessProof: proof => { proofs.push(proof); for (const listener of proofListeners) listener(proof); onBirth?.(); }, onState() {}, onTimeline() {},
  } satisfies ProviderOptions);
  const pump = (async () => { for await (const _event of native) { /* Drain native receipts. */ } })();
  void pump.catch(() => {});
  let confirmedAdmission = false, acknowledgedPump = false, pumpFailure: unknown;
  cleanups.push(() => cleanupClaude({
    join: () => native.join(), pump, proofs,
    subscribe: listener => { proofListeners.add(listener); return () => { proofListeners.delete(listener); }; },
    child: () => child, close: () => childClose,
    stop: pid => { const socket = controls.get(pid); if (socket && !socket.destroyed && !socket.writableEnded) socket.end("stop"); },
    restoreDisconnect: () => restoreDisconnect?.(),
    expectedJoin: error => admissionFailure && confirmedAdmission && error instanceof Error && "errorClass" in error && error.errorClass === "native_dispatch_rejected",
    expectedPump: error => acknowledgedPump && error === pumpFailure,
  }, Date.now() + 5000));
  return {
    native, log, probe, sessionId, proofs,
    confirmAdmission: async () => {
      const error = await native.initializationResult().then(() => { throw new Error("Expected admission rejection."); }, error => error);
      expect(error).toMatchObject({ errorClass: "native_dispatch_rejected" }); confirmedAdmission = true; return error;
    },
    expectPumpFailure: async (verify: (error: unknown) => void) => {
      const result = await bounded(pumpHandled(pump), Date.now() + 5000, "Claude pump observation");
      if (result.status !== "rejected") throw new Error("Expected provider pump failure.");
      verify(result.reason); pumpFailure = result.reason; acknowledgedPump = true;
    },
  };
};

test("native fixture cleanup waits through exiting and refuses a replacement", async () => {
  const proof: ProcessProof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "hash" };
  const stop = vi.fn();
  const observe = vi.fn<typeof inspectBootstrapProcessProof>().mockResolvedValueOnce("exiting").mockResolvedValueOnce("stopped");
  await waitForNativeStop(proof, Date.now() + 1000, stop, observe);
  expect(observe).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled();
  await expect(waitForNativeStop(proof, Date.now() + 1000, stop, vi.fn<typeof inspectBootstrapProcessProof>().mockResolvedValue("replaced"))).rejects.toThrow(/replaced/);
  expect(stop).not.toHaveBeenCalled();
});

test("Claude cleanup observes a late proof while join waits and drains its owned resources", async () => {
  const proof: ProcessProof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "hash" };
  const proofs: ProcessProof[] = [], events: string[] = [];
  let listener: ((proof: ProcessProof) => void) | undefined, finishJoin!: () => void, finishPump!: () => void, finishClose!: () => void;
  const join = new Promise<void>(resolve => { finishJoin = resolve; });
  const pump = new Promise<void>(resolve => { finishPump = resolve; });
  const close = new Promise<void>(resolve => { finishClose = resolve; });
  const child = { exitCode: null, signalCode: null, kill: () => { events.push("helper kill"); finishClose(); return true; } } as unknown as ChildProcess;
  const inspect = vi.fn<typeof inspectBootstrapProcessProof>().mockResolvedValueOnce("exiting").mockResolvedValueOnce("running").mockResolvedValueOnce("stopped");
  const result = cleanupClaude({
    join: () => join, pump, proofs, child: () => child, close: () => close,
    subscribe: value => { listener = value; return () => { listener = undefined; }; },
    stop: () => { events.push("native stop"); finishJoin(); finishPump(); },
    restoreDisconnect: () => {}, observe: inspect,
  }, Date.now() + 1000);
  queueMicrotask(() => { proofs.push(proof); listener?.(proof); });
  await result;
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(events).toEqual(["native stop", "helper kill"]);
  expect(listener).toBeUndefined();
});

test("Claude cleanup waits for a birth receipt arriving after join rejects", async () => {
  const proof: ProcessProof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "hash" };
  const proofs: ProcessProof[] = [], events: string[] = [], joinError = new Error("join failed");
  let listener: ((proof: ProcessProof) => void) | undefined, finishClose!: () => void;
  const close = new Promise<void>(resolve => { finishClose = resolve; });
  const child = { exitCode: null, signalCode: null, kill: () => { events.push("helper close"); finishClose(); return true; } } as unknown as ChildProcess;
  const observe = vi.fn<typeof inspectBootstrapProcessProof>().mockResolvedValueOnce("running").mockResolvedValueOnce("stopped");
  const result = cleanupClaude({
    join: () => Promise.reject(joinError), pump: Promise.resolve(), proofs,
    subscribe: value => { listener = value; return () => { listener = undefined; }; },
    child: () => child, close: () => close, stop: () => { events.push("native stop"); },
    restoreDisconnect: () => {}, observe,
  }, Date.now() + 1000).catch(error => error);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(events).toEqual([]);
  proofs.push(proof); listener?.(proof);
  const failure = await result;
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toContain(joinError);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["native stop", "helper close"]);
});

test("Claude cleanup reports proof, join and pump failures after helper close", async () => {
  const proof: ProcessProof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "hash" };
  const joinError = new Error("join failed"), pumpError = new Error("pump failed"), actions: string[] = [];
  let finishClose!: () => void;
  const close = new Promise<void>(resolve => { finishClose = resolve; });
  const child = { exitCode: null, signalCode: null, kill: () => { actions.push("close"); finishClose(); return true; } } as unknown as ChildProcess;
  const outcome = await settleCleanups([
    () => cleanupClaude({
      join: () => Promise.reject(joinError), pump: Promise.reject(pumpError), proofs: [proof],
      subscribe: () => () => {}, child: () => child, close: () => close,
      stop: () => { actions.push("stop"); }, restoreDisconnect: () => {},
      observe: vi.fn<typeof inspectBootstrapProcessProof>().mockResolvedValue("replaced"),
    }, Date.now() + 1000),
    async () => { actions.push("fixture"); },
  ]).catch(error => error);
  expect(actions).toEqual(["close", "fixture"]);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome.errors[0].errors).toEqual(expect.arrayContaining([joinError, pumpError, expect.objectContaining({ message: expect.stringMatching(/replaced/) })]));
});

test("Claude cleanup drains the helper after the cooperative deadline", async () => {
  const actions: string[] = [];
  let finishJoin!: () => void, finishPump!: () => void, finishClose!: () => void;
  const join = new Promise<void>(resolve => { finishJoin = () => { actions.push("join"); resolve(); }; });
  const pump = new Promise<void>(resolve => { finishPump = () => { actions.push("pump"); resolve(); }; });
  const close = new Promise<void>(resolve => { finishClose = () => { actions.push("close"); resolve(); }; });
  const child = { exitCode: null, signalCode: null, kill: () => { actions.push("kill"); finishClose(); finishJoin(); finishPump(); return true; } } as unknown as ChildProcess;
  const outcome = await settleCleanups([
    () => cleanupClaude({ join: () => join, pump, proofs: [], subscribe: () => () => {}, child: () => child, close: () => close, stop: () => {}, restoreDisconnect: () => {} }, Date.now() + 500),
    async () => { actions.push("fixture"); },
  ]).catch(error => error);
  expect(actions).toEqual(["kill", "close", "join", "pump", "fixture"]);
  expect(outcome.errors[0].errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/cooperative cleanup.*deadline/) })]);
});

test("fixture cleanup runs every action and retains each failure", async () => {
  const first = new Error("first"), second = new Error("second"), actions: number[] = [];
  const failure = await settleCleanups([
    async () => { actions.push(1); throw first; },
    async () => { actions.push(2); },
    async () => { actions.push(3); throw second; },
  ]).catch(error => error);
  expect(actions).toEqual([1, 2, 3]); expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([first, second]);
});

test("a real Claude helper refuses native startup from its frozen closed Worker binding", async () => {
  const value = await fixture(); value.disable(); const run = await claude(value, undefined, true);
  await expect(run.native.initializationResult()).rejects.toThrow();
  const admissionError = await run.confirmAdmission();
  await run.expectPumpFailure(error => { expect(error).toBe(admissionError); });
  expect(run.proofs).toEqual([]); await expect(readFile(run.log)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(run.native.join()).resolves.toBeUndefined();
}, 20_000);

test("a delayed Claude version probe rechecks SQLite after its native birth receipt", async () => {
  const value = await fixture(), run = await claude(value, value.disable, true);
  await expect(run.native.initializationResult()).rejects.toThrow();
  await run.confirmAdmission();
  // This generic provider failure has no cause field; its attribution is unknown.
  await run.expectPumpFailure(error => { expect(error).toMatchObject({ message: "Claude helper lost its native connection; operation results are unknown." }); });
  expect(run.proofs).toHaveLength(1);
  await expect(readFile(run.probe)).rejects.toMatchObject({ code: "ENOENT" });
}, 25_000);

test("a running Claude helper rejects input and controls after disable but retains interrupt and stop", async () => {
  const value = await fixture(), run = await claude(value);
  await run.native.initializationResult(); value.disable();
  await expect(run.native.submit({ uuid: randomUUID(), sessionId: run.sessionId, input: { content: [{ type: "text", text: "must not run" }] } })).rejects.toMatchObject({ errorClass: "native_dispatch_rejected" });
  await expect(run.native.setModel("another-model")).rejects.toMatchObject({ errorClass: "native_dispatch_rejected" });
  await run.native.interrupt();
  await expect(run.native.join()).resolves.toBeUndefined();
  expect((await readFile(run.log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line).event)).not.toContain("input");
}, 25_000);

test("Copilot rechecks persistent admission after real asynchronous tool verification before spawn", async () => {
  const value = await fixture(), entry = path.join(value.root, "copilot.mjs"), marker = path.join(value.root, "started");
  await writeFile(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');console.log('Listening on port 12345');setInterval(()=>{},1000);`);
  const operation = createOperation();
  let launch;
  try { launch = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "path", path: entry }, cwd: value.root, environment: process.env, workerNode: process.execPath }, operation); }
  finally { operation.dispose(); }
  let spawned = false;
  const runtime = startCopilotProcess({ cwd: value.root, toolLaunch: launch, onSpawn: () => { spawned = true; }, assertNativeDispatch: () => assertNativeLifecycleAdmission(value.fence) }, () => {});
  cleanups.push(() => runtime.close());
  // verifyToolLaunch has entered asynchronous filesystem work; no child exists yet.
  value.disable();
  await expect(runtime.ready).rejects.toThrow();
  expect(spawned).toBe(false); await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);


test("a real Copilot bridge independently rejects business calls after disable and permits shutdown", async () => {
  const value = await fixture(), log = path.join(value.root, "copilot.jsonl"), children: ChildProcess[] = [];
  const runtime = startCopilotRuntime({ cwd: value.root, model: null, args: [], resumeNativeSessionId: null,
    executable: path.resolve(import.meta.dirname, "fixtures/copilot-bridge-native.mjs"), nativeLifecycleFence: value.fence,
    env: { ...process.env, DAYNIGHT_TEST_BRIDGE_LOG: log, DAYNIGHT_TEST_BRIDGE_MODE: "normal", DAYNIGHT_TEST_BRIDGE_SHUTDOWN: "exit" },
    onSpawn: child => { children.push(child); }, onTimeline() {}, onState() {},
  }, () => {});
  cleanups.push(() => runtime.close(true));
  const client = await runtime.ready, session = await client.createSession({ sessionId: "fixture-session", onPermissionRequest: () => ({ kind: "no-result" }) });
  value.disable();
  await expect(session.send({ prompt: "must not run" })).rejects.toMatchObject({ errorClass: "native_dispatch_rejected" });
  await expect(session.rpc.mode.set({ mode: "autopilot" })).rejects.toMatchObject({ errorClass: "native_dispatch_rejected" });
  await expect(session.rpc.interruptMainTurn({})).resolves.toEqual({ interrupted: true });
  await runtime.close();
  expect(children).toHaveLength(2);
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  const methods = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).method);
  expect(methods).not.toContain("session.send"); expect(methods).not.toContain("session.mode.set"); expect(methods).toContain("session.interruptMainTurn"); expect(methods).toContain("runtime.shutdown");
}, 25_000);

test("Copilot does not spawn a late SDK bridge after its native process birth closes admission", async () => {
  const value = await fixture(), children: ChildProcess[] = [];
  const runtime = startCopilotRuntime({ cwd: value.root, model: null, args: [], resumeNativeSessionId: null,
    executable: path.resolve(import.meta.dirname, "fixtures/copilot-bridge-native.mjs"), nativeLifecycleFence: value.fence,
    assertNativeDispatch: () => assertNativeLifecycleAdmission(value.fence),
    env: { ...process.env, DAYNIGHT_TEST_BRIDGE_LOG: path.join(value.root, "copilot.jsonl"), DAYNIGHT_TEST_BRIDGE_MODE: "normal" },
    onSpawn: child => { children.push(child); value.disable(); }, onTimeline() {}, onState() {},
  }, () => {});
  cleanups.push(() => runtime.close(true));
  await expect(runtime.ready).rejects.toThrow(); await runtime.close(true);
  expect(children).toHaveLength(1); expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
}, 25_000);
