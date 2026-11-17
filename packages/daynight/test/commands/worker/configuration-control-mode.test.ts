import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { receivedDesired, receivedReceipt } from "../../helpers/worker-received-configuration.js";
import type { WorkerCloudDesired } from "../../../src/api/worker-configuration.js";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationManagerOptions, WorkerConfigurationSnapshot } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";
import { replaceFileAtomically } from "../../../src/platform/files.js";

const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const desired = (revision = "1"): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-18T00:00:00Z", value: {
  agentControlMode: "web", maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 3, preferPlatformSpecificTasks: false,
  native: { agent: "codex", model: null, args: [] }, projects: [],
} });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};
const mode = (snapshot: WorkerConfigurationSnapshot) => snapshot.items.find(item => item.key.kind === "agentControlMode");
const savedMode = (cache: WorkerConfigurationCache) => cache.currentItems.find(item => item.value.key.kind === "agentControlMode")!;
const directories: string[] = [];
const managers: { manager: WorkerConfigurationManager; expectedError?: Error }[] = [];
const fixture = async (overrides: Partial<WorkerConfigurationManagerOptions> = {}) => {
  const root = path.resolve(".tmp/configuration-control-mode-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")); directories.push(directory);
  const file = overrides.file ?? path.join(directory, "configuration.json"), controller = new AbortController();
  const snapshots: WorkerConfigurationSnapshot[] = [];
  const manager = await createWorkerConfigurationManager({ file, identity, signal: controller.signal, applyNative: async () => {}, ...overrides,
    onChange: snapshot => { snapshots.push(snapshot); overrides.onChange?.(snapshot); },
  });
  const owned: typeof managers[number] = { manager }; managers.push(owned);
  return { manager, controller, file, snapshots, owned,
    disk: async () => (await readConfigurationCache(file, identity, new AbortController().signal)).cache };
};
afterEach(async () => {
  try {
    for (const { manager, expectedError } of managers.splice(0)) {
      if (expectedError === undefined) await manager.stop();
      else await expect(manager.stop()).rejects.toBe(expectedError);
    }
  } finally { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); }
});

describe("Worker Web mode adoption", () => {
  it("upgrades unchanged schema 9 authority, adopts it after synchronization and restores its durable record", async () => {
    const initial = desired(), first = await fixture();
    await first.manager.receive(receivedDesired(initial), "4"); await first.manager.settle();
    const previous = await first.disk(); await first.manager.stop();
    const schema9 = { ...previous, schemaVersion: 9, currentItems: previous.currentItems.filter(item => item.value.key.kind !== "agentControlMode") };
    await writeFile(first.file, JSON.stringify(schema9));
    const next = await fixture({ file: first.file });
    const migrated = await next.disk(), pending = savedMode(migrated);
    expect(migrated.schemaVersion).toBe(10);
    expect(pending).toMatchObject({ value: { state: "pending", appliedValue: null, targetRevision: "1" }, actualSource: null });
    expect(next.manager.current().effective.agentControlMode).toBeNull();
    expect(next.manager.report().observation).toBeNull();
    await next.manager.receive(receivedDesired(initial), "4"); await next.manager.settle();
    const adopted = savedMode(await next.disk());
    expect(adopted.recordId).toBe(pending.recordId);
    expect(adopted).toMatchObject({ value: { state: "applied", appliedValue: "web" },
      actualSource: { kind: "observed", recordId: pending.recordId, generation: pending.origin.generation, targetRevision: "1" } });
    expect(next.manager.current().effective.agentControlMode).toBe("web");
    await next.manager.stop();
    const restarted = await fixture({ file: first.file });
    expect(savedMode(await restarted.disk())).toEqual(adopted);
    expect(restarted.manager.current().effective.agentControlMode).toBeNull();
    expect(restarted.manager.report().observation).toBeNull();
    await restarted.manager.receive(receivedDesired(initial), "4"); await restarted.manager.settle();
    expect(restarted.snapshots.some(snapshot => mode(snapshot)?.state === "pending" && snapshot.effective.agentControlMode === null)).toBe(true);
    expect(restarted.manager.current().effective.agentControlMode).toBe("web");
  });

  it("retains the applied target revision when an equal newer desired revision arrives", async () => {
    const run = await fixture();
    await run.manager.receive(receivedDesired(desired()), "3"); await run.manager.settle();
    const original = savedMode(await run.disk());
    run.snapshots.length = 0;
    await run.manager.receive(receivedDesired(desired("2")), "3"); await run.manager.settle();
    expect(savedMode(await run.disk())).toEqual(original);
    expect(run.manager.current().desiredRevision).toBe("2");
    expect(run.manager.current().applicationRevision).toBe("1");
    expect(run.manager.current().effective.agentControlMode).toBe("web");
    const report = run.manager.report();
    expect(report.observation).toMatchObject({ desiredRevision: "2", items: expect.arrayContaining([{ ...original.value, targetRevision: "1" }]) });
    expect(run.snapshots.every(snapshot => mode(snapshot)?.state === "applied")).toBe(true);
  });

  it.each(["herdr", null, "absent"] as const)("requires new adoption after an unsupported %s target and ignores its old report", async controlMode => {
    const run = await fixture();
    await run.manager.receive(receivedDesired(desired()), "2"); await run.manager.settle();
    const original = savedMode(await run.disk()), oldReport = run.manager.report();
    const { agentControlMode: _mode, ...withoutMode } = desired().value;
    const unsupported: WorkerCloudDesired = { ...desired("2"), value: controlMode === "absent" ? withoutMode : { ...desired().value, agentControlMode: controlMode } };
    await run.manager.receive(receivedDesired(unsupported), "2"); await run.manager.settle();
    expect(run.manager.current().effective.agentControlMode).toBeNull();
    expect(run.manager.report().observation).toBeNull();
    expect((await run.disk()).authority.desiredJson).toBe(JSON.stringify(unsupported));
    run.snapshots.length = 0;
    await run.manager.receive(receivedDesired(desired("3")), "2"); await run.manager.settle();
    const next = savedMode(await run.disk());
    expect(next.recordId).not.toBe(original.recordId);
    expect(next.actualSource).toEqual({ kind: "observed", recordId: next.recordId, generation: next.origin.generation, targetRevision: "3" });
    expect(run.snapshots.some(snapshot => mode(snapshot)?.state === "pending" && mode(snapshot)?.appliedValue === null && snapshot.effective.agentControlMode === null)).toBe(true);
    await expect(run.manager.acknowledge(oldReport, receivedReceipt({ desired: desired(), observationRevision: "3", observationAccepted: true }))).resolves.toBe("ignored");
    expect(savedMode(await run.disk())).toEqual(next);
    expect(run.manager.current().desiredRevision).toBe("3");
  });

  it("invalidates a prior report when authority observation is reset and rechecks mode adoption", async () => {
    const run = await fixture();
    await run.manager.receive(receivedDesired(desired()), "5"); await run.manager.settle();
    const original = await run.disk(), oldReport = run.manager.report();
    run.snapshots.length = 0;
    await run.manager.receive(receivedDesired(desired()), "0"); await run.manager.settle();
    const reset = await run.disk(), adopted = savedMode(reset);
    expect(reset.authority.generation).not.toBe(original.authority.generation);
    expect(adopted.recordId).not.toBe(savedMode(original).recordId);
    expect(adopted.actualSource).toEqual({ kind: "observed", recordId: adopted.recordId, generation: reset.authority.generation, targetRevision: "1" });
    expect(run.snapshots.some(snapshot => mode(snapshot)?.state === "pending" && snapshot.effective.agentControlMode === null)).toBe(true);
    expect(run.manager.current().effective.agentControlMode).toBe("web");
    await expect(run.manager.acknowledge(oldReport, receivedReceipt({ desired: desired(), observationRevision: "6", observationAccepted: true }))).resolves.toBe("ignored");
    expect(run.manager.current().observationRevision).toBe("0");
  });

  it("does not let a lower desired receipt replace the current adoption record", async () => {
    const run = await fixture();
    await run.manager.receive(receivedDesired(desired()), "2"); await run.manager.settle();
    const sent = run.manager.report();
    await run.manager.receive(receivedDesired(desired("2")), "4"); await run.manager.settle();
    const original = savedMode(await run.disk());
    await expect(run.manager.acknowledge(sent, receivedReceipt({ desired: desired(), observationRevision: "3", observationAccepted: true }))).resolves.toBe("persisted");
    expect(run.manager.current().desiredRevision).toBe("2");
    expect(run.manager.current().observationRevision).toBe("4");
    expect(savedMode(await run.disk())).toEqual(original);
    expect(run.manager.current().effective.agentControlMode).toBe("web");
  });

  it("does not adopt an authority checkpoint after Worker cancellation", async () => {
    const entered = deferred(), release = deferred();
    let gated = false;
    const run = await fixture({ persist: async (file, chunks) => {
      const contents = [...chunks()].join(""), checkpoint = JSON.parse(contents) as WorkerConfigurationCache;
      if (!gated && checkpoint.authority.desiredJson !== null) { gated = true; entered.resolve(); await release.promise; }
      await replaceFileAtomically(file, contents, 0o600);
    } });
    const reason = new Error("Worker stopped before authority adoption");
    const receive = run.manager.receive(receivedDesired(desired())).catch(error => error);
    try {
      await entered.promise;
      run.controller.abort(reason);
      expect(await receive).toBe(reason);
      expect(run.manager.current().effective.agentControlMode).toBeNull();
    } finally { release.resolve(); }
    await run.manager.stop();
    expect(savedMode(await run.disk())).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    expect(run.snapshots.every(snapshot => snapshot.effective.agentControlMode === null)).toBe(true);
    expect(() => run.manager.report()).toThrow(/stopped/);
  });

  it("keeps mode pending and blocks reports when the adoption checkpoint fails", async () => {
    const failure = new TypeError("adoption checkpoint encoding failed"), failed = deferred();
    const run = await fixture({ onError: () => failed.resolve(), persist: async (file, chunks) => {
      const contents = [...chunks()].join(""), checkpoint = JSON.parse(contents) as WorkerConfigurationCache;
      if (savedMode(checkpoint)?.value.state === "applied") throw failure;
      await replaceFileAtomically(file, contents, 0o600);
    } });
    run.owned.expectedError = failure;
    await run.manager.receive(receivedDesired(desired()));
    await failed.promise;
    await expect(run.manager.settle()).rejects.toBe(failure);
    expect(savedMode(await run.disk())).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    expect(run.manager.current().effective.agentControlMode).toBeNull();
    expect(run.snapshots.every(snapshot => snapshot.effective.agentControlMode === null)).toBe(true);
    expect(run.manager.isReady()).toBe(false);
    expect(() => run.manager.report()).toThrow(failure);
  });
});
