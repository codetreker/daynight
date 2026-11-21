import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import { freezeNativeLifecycleFence } from "../../../src/commands/controller/native-lifecycle.js";
import { inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { startCopilotProcess } from "../../../src/commands/controller/providers/copilot-owned-process.js";
import { assertNativeLifecycleAdmission } from "../../../src/commands/controller/native-lifecycle.js";

// These helpers execute their production IPC and native subprocess boundaries.
const { queryClaudeLive } = await import(new URL("../../../dist/commands/controller/providers/claude-live.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude-live.js");
const { startCopilotRuntime } = await import(new URL("../../../dist/commands/controller/providers/copilot-runtime.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/copilot-runtime.js");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/native-lifecycle"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), file = path.join(root, "lifecycle.sqlite");
  const identity = { serverOrigin: "https://daynight.example", userId: randomUUID(), workerId: randomUUID() };
  const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), instanceEpoch: "1", localEpoch: "1", intentVersion: "1", scopeGeneration: "1" };
  const store = openLifecycleStore({ file, identity, allowCreate: true });
  store.bindInstance({ ...binding, desired: "enabled" }); store.markStopped({ localEpoch: "1", inventoryRevision: store.readState().inventoryRevision });
  const activation = { binding, action: "bootstrap" as const, operationId: randomUUID() };
  store.prepareActivation(activation); store.commitActivation({ ...activation, receipt: { protocolVersion: 1, action: "bootstrap", admission: "open", operationId: activation.operationId, workerId: identity.workerId, instanceEpoch: "1", localEpoch: "1", intentVersion: "1", scopeGeneration: "1" } });
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, fence: freezeNativeLifecycleFence({ file, binding }), disable: () => store.closeAdmission({ operationId: randomUUID(), local: true }) };
};
const claude = async (value: Awaited<ReturnType<typeof fixture>>, onBirth?: () => void) => {
  const log = path.join(value.root, "native.jsonl"), probe = path.join(value.root, "version-probe"), executable = path.join(value.root, "native.mjs"), sessionId = randomUUID();
  await writeFile(executable, `import { writeFileSync } from 'node:fs';if(process.argv.includes('--version'))writeFileSync(${JSON.stringify(probe)},'started');await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "fixtures/claude-live-native.mjs")).href)});`);
  const env = { ...process.env, HOME: value.root, USERPROFILE: value.root, CLAUDE_CONFIG_DIR: value.root, DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log };
  let child: ChildProcess | undefined; const proofs: ProcessProof[] = [];
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: value.root, sessionId, settingSources: [], pathToClaudeCodeExecutable: executable, env } }, {
    cwd: value.root, model: null, args: [], resumeNativeSessionId: null, env, nativeLifecycleFence: value.fence,
    // No parent assertion: the helper must independently reject the native call.
    onSpawn: process => { child = process; }, onNativeProcessProof: proof => { proofs.push(proof); onBirth?.(); }, onState() {}, onTimeline() {},
  } satisfies ProviderOptions);
  const pump = (async () => { for await (const _event of native) { /* Drain native receipts. */ } })().catch(error => error);
  cleanups.push(async () => {
    await native.join().catch(() => {});
    for (const proof of proofs) if (await inspectProcessProof(proof) === "running") process.kill(proof.pid, "SIGKILL");
    for (const proof of proofs) await expect.poll(() => inspectProcessProof(proof), { timeout: 5000 }).toBe("stopped");
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(resolve => child!.once("close", () => resolve())); child.kill("SIGKILL"); await exit;
    }
    await pump;
  });
  return { native, log, probe, sessionId, proofs };
};

test("a real Claude helper refuses native startup from its frozen closed Worker binding", async () => {
  const value = await fixture(); value.disable(); const run = await claude(value);
  await expect(run.native.initializationResult()).rejects.toThrow();
  expect(run.proofs).toEqual([]); await expect(readFile(run.log)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(run.native.join()).resolves.toBeUndefined();
}, 20_000);

test("a delayed Claude version probe rechecks SQLite after its native birth receipt", async () => {
  const value = await fixture(), run = await claude(value, value.disable);
  await expect(run.native.initializationResult()).rejects.toThrow();
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
