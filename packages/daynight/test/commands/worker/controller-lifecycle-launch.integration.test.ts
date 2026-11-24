import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const fault = vi.hoisted(() => ({ stopOnce: false, releaseThenThrow: false }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args), kill = child.kill.bind(child), send = child.send?.bind(child);
    child.kill = (...parameters: Parameters<typeof child.kill>) => {
      if (fault.stopOnce) { fault.stopOnce = false; throw new Error("Original stop attempt unavailable."); }
      return kill(...parameters);
    };
    if (send) child.send = ((...parameters: Parameters<typeof child.send>) => {
      const result = send(...parameters);
      if (fault.releaseThenThrow) { fault.releaseThenThrow = false; throw new Error("Gate release result was lost."); }
      return result;
    }) as typeof child.send;
    return child;
  } };
});
vi.mock("../../../src/platform/windows-suspended-process.js", async original => {
  const actual = await original<typeof import("../../../src/platform/windows-suspended-process.js")>();
  return { ...actual, createSuspendedProcess: async (...args: Parameters<typeof actual.createSuspendedProcess>) => {
    const child = await actual.createSuspendedProcess(...args);
    return { ...child, terminate: () => {
      if (fault.stopOnce) { fault.stopOnce = false; throw new Error("Original stop attempt unavailable."); }
      child.terminate();
    }, resume: () => {
      child.resume();
      if (fault.releaseThenThrow) { fault.releaseThenThrow = false; throw new Error("Gate release result was lost."); }
    } };
  } };
});
vi.mock("../../../src/commands/controller/storage-preparation.js", async original => ({
  ...await original<typeof import("../../../src/commands/controller/storage-preparation.js")>(),
  prepareControllerStorage: () => ({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false }),
}));
import { launchControllerProcess } from "../../../src/commands/worker/backends/controller-process.js";
import { controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openLifecycleStore, type LifecycleBinding, type LifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { confirmControllerProcessesStopped, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";

const roots: string[] = [], stores: LifecycleStore[] = [], cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  fault.stopOnce = false; fault.releaseThenThrow = false;
  await Promise.all(cleanups.splice(0).map(close => close()));
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-lifecycle-launch"); await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "case-")); roots.push(homeDirectory);
  vi.stubEnv("DN_CONFIG_DIR", path.join(homeDirectory, "state"));
  const worker = resolveWorkerPaths(homeDirectory).workerDirectory; await mkdir(worker, { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: "https://daynight.example", userId: randomUUID(), workerId: randomUUID() };
  const file = path.join(worker, "lifecycle.sqlite"), store = openLifecycleStore({ file, identity, allowCreate: true }); stores.push(store);
  const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), localEpoch: "1", intentVersion: "1", scopeGeneration: "1" };
  store.bindInstance({ ...binding, desired: "enabled" }); store.markStopped({ localEpoch: "1", inventoryRevision: store.readState().inventoryRevision });
  const activation = { binding, operationId: randomUUID(), action: "bootstrap" as const };
  store.prepareActivation(activation); store.commitActivation({ ...activation, receipt: { protocolVersion: 1, action: "bootstrap", admission: "open", operationId: activation.operationId, workerId: identity.workerId, instanceId: binding.instanceId, localEpoch: "1", intentVersion: "1", scopeGeneration: "1" } });
  const marker = path.join(homeDirectory, "user-code-started"), packageDirectory = path.join(homeDirectory, "package");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  await writeFile(path.join(packageDirectory, "dist", "main.js"), `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`);
  const ticket: ControllerLaunchTicket = { schemaVersion: 2, lifecycleBinding: binding, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: identity.serverOrigin,
    testExecutionId: randomUUID(), ownerUserId: identity.userId, provider: "codex", cwd: homeDirectory, nativeHome: path.join(homeDirectory, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null,
    credentialFile: path.join(homeDirectory, "grant.json"), ipcEndpoint: path.join(homeDirectory, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await mkdir(controllerExecutionDirectory(homeDirectory, ticket.executionId), { recursive: true });
  const retained = new Map<string, (deadline: number) => Promise<void>>();
  const retainBirthCleanup = (cleanup: (deadline: number) => Promise<void>) => { retained.set(ticket.launchId, cleanup); return () => { retained.delete(ticket.launchId); }; };
  let proof: ProcessProof | undefined, lease: ControllerJobLease | undefined, closeHandles: (() => void) | undefined;
  const options = { homeDirectory, packageDirectory, ticket, env: { ...process.env }, signal: new AbortController().signal,
    retainBirthCleanup, onSubmitting: () => {}, onSpawned: (birth: ProcessProof, ownership?: { lease: ControllerJobLease; closeHandles(): void }) => { proof = birth; lease = ownership?.lease; closeHandles = ownership?.closeHandles; }, onObserved: () => {} };
  cleanups.push(async () => {
    for (const cleanup of retained.values()) await cleanup(Date.now() + 10_000);
    retained.clear();
    if (proof) {
      // Successful pre-exec cleanup already closed and released its own handles.
      const resource = store.getResource(ticket.launchId);
      if (resource?.stage !== "stopped") {
        await stopControllerProcesses(proof, [], Date.now() + 10_000, lease);
        expect(await confirmControllerProcessesStopped(proof, [], Date.now() + 10_000, lease)).toBe(true);
        closeHandles?.(); if (lease) releaseControllerJobLease(lease);
      }
    }
  });
  return { options, store, file, identity, marker, retained, capture: options.onSpawned };
};

test.each(["submission", "cancellation"] as const)("closes the original durable reservation when %s fails before process creation", async reason => {
  const value = await fixture(), cancellation = new AbortController();
  const onSubmitting = reason === "submission" ? () => { throw new Error("Submission save failed."); } : async () => { cancellation.abort(new Error("Submission cancelled.")); };
  await expect(launchControllerProcess({ ...value.options, signal: cancellation.signal, onSubmitting })).rejects.toThrow(/Submission/);
  expect(value.store.getResource(value.options.ticket.launchId)).toMatchObject({ stage: "not_dispatched", processProof: null, saveState: "durable" });
  expect(value.retained.size).toBe(0);
  const reopened = openLifecycleStore({ file: value.file, identity: value.identity });
  try { expect(reopened.getResource(value.options.ticket.launchId)?.stage).toBe("not_dispatched"); } finally { reopened.close(); }
  await expect(readFile(value.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an actual OS spawn refusal closes its reservation without claiming a process birth", async () => {
  const value = await fixture();
  await expect(launchControllerProcess({ ...value.options, ticket: { ...value.options.ticket, cwd: path.join(value.options.homeDirectory, "missing-directory") } })).rejects.toThrow("operating system rejected");
  expect(value.store.getResource(value.options.ticket.launchId)).toMatchObject({ stage: "not_dispatched", processProof: null, stopProof: null });
  expect(value.retained.size).toBe(0);
});

test("a real unreleased Controller gate is stopped and durably closed after its birth callback fails", async () => {
  const value = await fixture(); let pid: number | undefined;
  await expect(launchControllerProcess({ ...value.options, onSpawned: (proof, ownership) => { pid = proof.pid; value.capture(proof, ownership); throw new Error("Birth callback failed."); } })).rejects.toThrow("Birth callback failed");
  expect(value.store.getResource(value.options.ticket.launchId)).toMatchObject({ stage: "stopped", processProof: { pid }, stopProof: { kind: "controller_unreleased_gate", pid, gateReleased: false, boundaryEmpty: true } });
  expect(() => process.kill(pid!, 0)).toThrow();
  expect(value.retained.size).toBe(0);
  await expect(readFile(value.marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);

test("retained pre-exec cleanup closes the reservation after the original launcher connection has closed", async () => {
  const value = await fixture(); fault.stopOnce = true;
  await expect(launchControllerProcess({ ...value.options, onSpawned: (proof, ownership) => { value.capture(proof, ownership); throw new Error("Birth callback failed."); } })).rejects.toThrow("retained original birth handles");
  expect(value.store.getResource(value.options.ticket.launchId)?.stage).toBe("running");
  expect(value.retained.size).toBe(1);
  await value.retained.get(value.options.ticket.launchId)!(Date.now() + 10_000);
  expect(value.store.getResource(value.options.ticket.launchId)).toMatchObject({ stage: "stopped", stopProof: { gateReleased: false, boundaryEmpty: true } });
  await expect(readFile(value.marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);

test("an ambiguous gate release retains running responsibility even when the send throws", async () => {
  const value = await fixture(); fault.releaseThenThrow = true;
  await expect(launchControllerProcess(value.options)).rejects.toThrow("Gate release result was lost");
  await expect.poll(() => readFile(value.marker, "utf8"), { timeout: 10_000 }).toBe("started");
  expect(value.store.getResource(value.options.ticket.launchId)).toMatchObject({ stage: "running", stopProof: null });
  expect(value.retained.size).toBe(0);
}, 20_000);
