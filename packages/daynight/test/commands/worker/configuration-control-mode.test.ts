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
  toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } }, maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 3, preferPlatformSpecificTasks: false,
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

describe("Worker Web configuration", () => {
  it("revalidates a persisted v2 target after restart without producing mode facts", async () => {
    const first = await fixture(), initial = desired();
    await first.manager.receive(receivedDesired(initial), "4"); await first.manager.settle();
    await first.manager.stop();
    const restarted = await fixture({ file: first.file });
    expect(restarted.manager.current().effective.native).toBeNull();
    await restarted.manager.receive(receivedDesired(initial), "4"); await restarted.manager.settle();
    expect(restarted.manager.current().effective.agentControlMode).toBe("web");
    expect(restarted.manager.current().effective.native).toEqual(initial.value.native);
    expect(mode(restarted.manager.current())).toBeUndefined();
    expect(restarted.manager.report().observation?.items.some(item => item.key.kind === "agentControlMode")).toBe(false);
  });

  it("retains an explicit legacy mode without applying it", async () => {
    const run = await fixture(), initial = desired();
    await run.manager.receive(receivedDesired(initial)); await run.manager.settle();
    const legacy = { ...desired("2"), value: { ...initial.value, agentControlMode: "web" as const } };
    await run.manager.receive(receivedDesired(legacy)); await run.manager.settle();
    expect(run.manager.current().effective.native).toBeNull();
    expect(run.manager.report().observation).toBeNull();
    expect(JSON.parse((await run.disk()).authority.desiredJson!)).toEqual(legacy);
  });
});
