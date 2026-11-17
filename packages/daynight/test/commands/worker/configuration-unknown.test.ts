import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReceivedWorkerConfigurationReceipt, parseReceivedWorkerConfigurationResource, receiveWorkerDesired } from "../../../src/api/worker-configuration.js";
import { createWorkerConfigurationManager, type WorkerConfigurationManager, type WorkerConfigurationManagerOptions } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";

const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const projectId = "11111111-1111-4111-8111-111111111111";
const future = '{"boolean":true,"nil":null,"array":[-1.25,1e100000000000000000000,900719925474099312345],"__proto__":{"future":false}}';
const desired = (revision: string, extra = future) => receiveWorkerDesired(`{"revision":"${revision}","updatedAt":"2026-11-17T00:00:00Z","value":{"maxConcurrent":2,"pollIntervalMs":1200,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[],"future":${extra}},"projects":[{"projectId":"${projectId}","nativeOverrides":{"future":${extra}},"future":${extra}}],"toolPaths":{"codex":{"kind":"auto","future":${extra}},"copilot":{"kind":"auto"},"herdr":{"kind":"auto"},"future":${extra}},"future":${extra}},"future":${extra}}`);
const receipt = (target: ReturnType<typeof desired>, revision: string, accepted: boolean) => parseReceivedWorkerConfigurationReceipt({ json: `{"desired":${target.json},"observationRevision":"${revision}","observationAccepted":${accepted}}` });
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; };
const managers: WorkerConfigurationManager[] = [], directories: string[] = [];
const fixture = async (options: Partial<WorkerConfigurationManagerOptions> = {}) => {
  const root = path.resolve(".tmp/configuration-unknown-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")); directories.push(directory);
  const file = options.file ?? path.join(directory, "configuration.json");
  const manager = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {}, ...options });
  managers.push(manager);
  return { manager, file, read: async (): Promise<WorkerConfigurationCache> => JSON.parse(await readFile(file, "utf8")) };
};
afterEach(async () => { for (const manager of managers.splice(0)) await manager.stop(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("Worker future configuration persistence", () => {
  it("retains future desired and remote observations through manager shutdown and restart without reporting them", async () => {
    const first = await fixture(), target = desired("1");
    const observation = `{"baseRevision":"3","desiredRevision":"1","reportedAt":"2026-11-17T00:00:00Z","items":[{"key":{"kind":"future"},"appliedValue":${future},"future":-3e-200}]}`;
    const resource = parseReceivedWorkerConfigurationResource({ json: `{"desired":${target.json},"observationRevision":"4","observation":${observation}}` });
    await first.manager.receive(resource.desired, resource.observationRevision, undefined, undefined, { observationRevision: resource.observationRevision, json: resource.observationJson! });
    await first.manager.settle();
    const saved = await first.read();
    expect(saved.authority.desiredJson).toBe(target.json);
    expect(saved.remoteObservation).toEqual({ observationRevision: "4", json: observation });
    expect(saved.currentItems.map(item => item.value.key.kind)).not.toContain("future");
    await first.manager.stop();
    const second = await fixture({ file: first.file });
    expect(await second.read()).toEqual(saved);
    await second.manager.receive(target, "4"); await second.manager.settle();
    const sent = second.manager.report();
    expect(JSON.stringify(sent)).not.toContain("future");
    await second.manager.acknowledge(sent, receipt(target, "5", true));
    expect((await second.read()).remoteObservation).toEqual(saved.remoteObservation);
    expect((await second.read()).authority.desiredJson).toBe(target.json);
  });

  it("preserves in-flight tool preparation, item identities and application revision across future-only updates", async () => {
    const entered = barrier(), release = barrier(), prepare = vi.fn<NonNullable<WorkerConfigurationManagerOptions["prepareToolSelection"]>>(async (_native, _mode, targets, signal) => {
      expect(targets.revision).toBe("1"); entered.resolve(); await release.promise; expect(signal.aborted).toBe(false);
    });
    const apply = vi.fn(async () => {}), first = await fixture({ prepareToolSelection: prepare, applyNative: apply });
    await first.manager.configureProjectAdapters({ prepare: async () => false });
    try {
      await first.manager.receive(desired("1"), "0"); await entered.promise;
      const before = await first.read(), sent = first.manager.report();
      await first.manager.receive(desired("2", '{"new":-9.003e+999}'), "0");
      const after = await first.read();
      expect(after.authority.generation).toBe(before.authority.generation);
      expect(after.currentItems.map(({ recordId, origin, value }) => ({ recordId, origin, key: value.key, targetRevision: value.targetRevision }))).toEqual(before.currentItems.map(({ recordId, origin, value }) => ({ recordId, origin, key: value.key, targetRevision: value.targetRevision })));
      expect(first.manager.current()).toMatchObject({ applicationRevision: "1", desired: { revision: "2" }, toolTargets: { revision: "1" } });
      await first.manager.acknowledge(sent, receipt(desired("1"), "1", true));
      expect(first.manager.current().desired!.revision).toBe("2");
      await first.manager.confirmProjectPrepared(projectId, "1");
      expect(first.manager.current().effective.projects[0]!.ready).toBe(true);
    } finally { release.resolve(); }
    await first.manager.settle();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
    const sent = first.manager.report();
    expect(sent.observation!.desiredRevision).toBe("2");
    expect(sent.observation!.items.every(item => item.targetRevision === "1")).toBe(true);
    expect(first.manager.current().effective.native).not.toBeNull();
  });

  it("keeps a newer GET observation baseline when an earlier equal-target report arrives late", async () => {
    const first = await fixture(), target = desired("1");
    await first.manager.receive(target, "0"); await first.manager.settle();
    const sent = first.manager.report(), nullSent = first.manager.report();
    const observation = '{"baseRevision":"4","desiredRevision":"1","reportedAt":"2026-11-17T00:00:00Z","items":[]}';
    await first.manager.receive(target, "5", undefined, undefined, { observationRevision: "5", json: observation });
    const reset = parseReceivedWorkerConfigurationReceipt({ json: '{"desired":null,"observationRevision":"0","observationAccepted":false}' });
    await first.manager.acknowledge(nullSent, reset);
    expect(first.manager.current().desired!.revision).toBe("1");
    await first.manager.acknowledge(sent, receipt(target, "1", true));
    expect(first.manager.current().observationRevision).toBe("5");
    await first.manager.acknowledge(first.manager.report(), reset);
    expect(first.manager.current()).toMatchObject({ desired: null, observationRevision: "0" });
    await first.manager.stop();
    const second = await fixture({ file: first.file });
    expect((await second.read()).remoteObservation).toEqual({ observationRevision: "5", json: observation });
  });

  it("rejects same-revision semantic changes but accepts reordered members and equal lossless numbers", async () => {
    const first = await fixture(), target = desired("1", '{"n":1000,"large":9007199254740993}');
    await first.manager.receive(target, "0"); await first.manager.settle();
    const before = await first.read();
    await first.manager.receive(desired("1", '{"large":9007199254740993,"n":1e3}'), "0");
    expect((await first.read()).authority.generation).toBe(before.authority.generation);
    await expect(first.manager.receive(desired("1", '{"n":1000,"large":9007199254740992}'), "0")).rejects.toThrow();
    expect((await first.read()).authority.desiredJson).toContain('"large":9007199254740993');
    // The failed protocol commit is retained by the persistence owner and shutdown.
    const index = managers.indexOf(first.manager); managers.splice(index, 1);
    await expect(first.manager.stop()).rejects.toThrow();
  });
});
