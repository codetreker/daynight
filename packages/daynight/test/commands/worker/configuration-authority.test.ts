import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerCloudDesired } from "../../../src/api/worker-configuration.js";
import { parseWorkerCloudReport } from "../../../src/api/worker-configuration.js";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationManagerOptions } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const desired = (revision: string, model = "original", selected = true): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-12T00:00:00Z", value: { maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: { agent: "codex", model, args: [] }, projects: selected ? [{ projectId, nativeOverrides: {} }] : [] } });
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};
const active: { manager: WorkerConfigurationManager; directory: string }[] = [];
const fixture = async (overrides: Partial<WorkerConfigurationManagerOptions> = {}) => {
  const root = path.resolve(".tmp/worker-configuration-authority-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json");
  const manager = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {}, ...overrides });
  active.push({ manager, directory });
  return { manager, file, read: async (): Promise<WorkerConfigurationCache> => JSON.parse(await readFile(file, "utf8")) };
};
afterEach(async () => {
  for (const { manager } of active) await manager.stop();
  for (const { directory } of active.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Worker canonical configuration authority", () => {
  it.each([false, true])("replaces a higher desired and observation cursor from a trusted read after restart=%s", async restart => {
    const first = await fixture();
    await first.manager.receive(desired("10", "local", false), "90"); await first.manager.settle();
    const manager = restart ? (await fixture({ file: first.file })).manager : first.manager;
    if (restart) await first.manager.stop();
    await manager.receive(desired("5", "canonical", false), "3"); await manager.settle();
    expect(manager.current()).toMatchObject({ synchronized: true, desired: { revision: "5" }, observationRevision: "3", effective: { native: { model: "canonical" } } });
    expect(parseWorkerCloudReport(manager.report(), { controlMode: true, toolPaths: true }).observation).toMatchObject({ baseRevision: "3", desiredRevision: "5" });
    const saved = await first.read();
    expect(saved.authority).toMatchObject({ desired: { revision: "5" }, observationRevision: "3" });
    expect(saved.currentItems.every(item => BigInt(item.value.targetRevision) <= 5n)).toBe(true);
  });

  it("replaces same-revision content and accepts the exact lower canonical baseline from a rejected observation", async () => {
    const { manager, read } = await fixture();
    await manager.receive(desired("8", "previous", false), "30"); await manager.settle();
    const previous = manager.current().generation, sent = manager.report();
    await manager.acknowledge(sent, { desired: desired("8", "canonical", false), observationRevision: "2", observationAccepted: false });
    await manager.settle();
    expect(manager.current().generation).not.toBe(previous);
    expect(manager.current()).toMatchObject({ desired: { value: { native: { model: "canonical" } } }, observationRevision: "2", effective: { native: { model: "canonical" } } });
    expect(manager.isCurrentReport(sent)).toBe(false);
    expect((await read()).authority.observationRevision).toBe("2");
  });

  it("treats a null-observation false receipt as canonical initialization and a later null receipt as reset", async () => {
    const { manager, read } = await fixture();
    const initial = manager.report();
    expect(initial.observation).toBeNull();
    await manager.acknowledge(initial, { desired: desired("4", "imported", false), observationRevision: "0", observationAccepted: false });
    await manager.settle();
    const sent = manager.report();
    await manager.acknowledge(sent, { desired: null, observationRevision: "0", observationAccepted: false });
    expect(manager.current()).toMatchObject({ desired: null, observationRevision: "0", effective: { native: null, projects: [] } });
    expect(manager.report().observation).toBeNull();
    expect((await read()).retainedItems.some(item => item.value.key.kind === "native" && item.value.appliedValue !== null)).toBe(true);
  });

  it("renews authority generation without replacing a matching running record or cancelling its operation", async () => {
    const entered = barrier(), release = barrier();
    let signal: AbortSignal | undefined;
    const { manager, read } = await fixture({ applyNative: async (_native, current) => { signal = current; entered.resolve(); await release.promise; } });
    const target = desired("5", "unchanged", false);
    try {
      await manager.receive(target, "9"); await entered.promise;
      const before = await read(), sent = manager.report();
      await manager.receive({ ...target, updatedAt: "2026-11-12T00:01:00Z" }, "1");
      const after = await read();
      expect(after.authority.generation).not.toBe(before.authority.generation);
      expect(after.currentItems.find(item => item.value.key.kind === "native")!.recordId).toBe(before.currentItems.find(item => item.value.key.kind === "native")!.recordId);
      expect(signal!.aborted).toBe(false);
      expect(manager.isCurrentReport(sent)).toBe(false);
    } finally { release.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.model).toBe("unchanged");
  });

  it("checks stale receipt ownership inside the checkpoint queue after a lower authoritative read is durable", async () => {
    const entered = barrier(), release = barrier();
    let hold = false;
    const { manager, read } = await fixture({ now: () => Date.parse("2026-11-12T00:00:00Z"), applyNative: async native => { if (native.model === "bad") throw new TypeError("rejected native"); }, persist: async (file, chunks) => {
      if (hold) { hold = false; entered.resolve(); await release.promise; }
      await replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
    } });
    await manager.receive(desired("10", "bad", false), "9"); await manager.settle();
    const sent = manager.report(), generation = manager.current().generation;
    hold = true;
    const receiving = manager.receive(desired("5", "good", false), "1");
    await entered.promise;
    expect(manager.isCurrentReport(sent)).toBe(true);
    const accepting = manager.acknowledge(sent, { desired: desired("10", "bad", false), observationRevision: "10", observationAccepted: true });
    release.resolve();
    await Promise.all([receiving, accepting]); await manager.settle();
    const saved = await read();
    expect(saved.authority).toMatchObject({ desired: { revision: "5" }, observationRevision: "1" });
    expect(saved.authority.generation).not.toBe(generation);
    expect([...saved.currentItems, ...saved.retainedItems].some(item => item.failureId !== null)).toBe(true);
    expect(manager.current().effective.native?.model).toBe("good");
  });

  it.each(["5", "10"])("discards a late high-target result when the canonical revision becomes %s with different content", async revision => {
    const entered = barrier(), release = barrier();
    let oldSignal: AbortSignal | undefined;
    const { manager } = await fixture({ applyNative: async (native, signal) => {
      if (native.model === "superseded") { oldSignal = signal; entered.resolve(); await release.promise; }
    } });
    try {
      await manager.receive(desired("10", "superseded", false), "9"); await entered.promise;
      await manager.receive(desired(revision, "canonical", false), "1");
      expect(oldSignal!.aborted).toBe(true);
    } finally { release.resolve(); }
    await manager.settle();
    expect(manager.current()).toMatchObject({ desired: { revision }, observationRevision: "1", effective: { native: { model: "canonical" } } });
    expect(manager.report().observation!.items.find(item => item.key.kind === "native")).toMatchObject({ targetRevision: revision, appliedValue: { model: "canonical" }, state: "applied" });
  });

  it.each([false, true])("rebuilds project responsibility after high desired becomes null and lower target selected=%s is installed", async selected => {
    const prepare = vi.fn(async () => {}), remove = vi.fn(async () => {}), applyNative = vi.fn(async () => {});
    const { manager, read } = await fixture({ applyNative });
    await manager.configureProjectAdapters({ prepare, remove });
    await manager.receive(desired("10"), "20"); await manager.settle();
    const original = (await read()).currentItems.find(item => item.value.key.kind === "projectNative")!;
    await manager.receive(null, "0"); await manager.settle();
    expect(remove).not.toHaveBeenCalled();
    expect((await read()).retainedItems).toContainEqual(original);
    await manager.receive(desired("5", "original", selected), "1"); await manager.settle();
    const current = await read();
    expect(prepare).toHaveBeenCalledTimes(selected ? 2 : 1);
    expect(remove).toHaveBeenCalledTimes(selected ? 0 : 1);
    expect(manager.current().effective.projects).toEqual(selected ? [{ projectId, native: desired("5").value.native, ready: true }] : []);
    if (selected) {
      expect(current.currentItems.find(item => item.value.key.kind === "projectNative")!.actualSource).toEqual(original.actualSource);
      expect(applyNative).toHaveBeenCalledTimes(2);
    } else {
      expect(current.currentItems.find(item => item.value.key.kind === "projectRemoval")).toMatchObject({ value: { targetRevision: "5", state: "applied" } });
      expect(current.retainedItems.find(item => item.recordId === original.recordId)).toEqual(original);
    }
    expect(parseWorkerCloudReport(manager.report(), { controlMode: true, toolPaths: true }).observation!.items.every(item => BigInt(item.targetRevision) <= 5n)).toBe(true);
  });

  it.each([false, true])("retains the original high stop and performs current verification before lower target selected=%s becomes ready", async selected => {
    const entered = barrier(), release = barrier(), prepare = vi.fn(async () => {});
    let stops = 0;
    const { manager, read } = await fixture();
    await manager.configureProjectAdapters({ prepare, remove: async () => { if (++stops === 1) { entered.resolve(); await release.promise; } } });
    await manager.receive(desired("9"), "20"); await manager.settle();
    await manager.receive(desired("10", "original", false), "21"); await entered.promise;
    const original = (await read()).currentItems.find(item => item.value.key.kind === "projectRemoval")!;
    try {
      await manager.receive(desired("5", "original", selected), "1");
      const current = await read(), carrier = current.currentItems.find(item => item.value.key.kind === "projectRemoval")!;
      expect(current.retainedItems.find(item => item.recordId === original.recordId)).toMatchObject({ origin: original.origin, value: { targetRevision: "10", state: "applying" } });
      expect(carrier).toMatchObject({ value: { targetRevision: "5", state: "pending" }, blockedByRemovalId: original.recordId });
      expect(prepare).toHaveBeenCalledOnce();
      expect(manager.current().effective.projects.every(project => !project.ready)).toBe(true);
      expect(parseWorkerCloudReport(manager.report(), { controlMode: true, toolPaths: true }).observation!.items.every(item => BigInt(item.targetRevision) <= 5n)).toBe(true);
    } finally { release.resolve(); }
    await manager.settle();
    expect(stops).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(selected ? 2 : 1);
    expect(manager.current().effective.projects).toEqual(selected ? [{ projectId, native: desired("5").value.native, ready: true }] : []);
    expect((await read()).retainedItems.find(item => item.recordId === original.recordId)).toMatchObject({ origin: original.origin, value: { targetRevision: "10", state: "applied" } });
  });
});
