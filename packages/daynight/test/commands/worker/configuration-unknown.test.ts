import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerConfigurationExchange } from "../../../src/commands/worker/configuration-exchange.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";
import { parseReceivedWorkerConfigurationReceipt, parseReceivedWorkerConfigurationResource, receiveWorkerDesired } from "../../../src/api/worker-configuration.js";
import { desiredCapabilitySources } from "../../../src/api/worker-configuration-source.js";
import { createWorkerConfigurationManager, type WorkerConfigurationManager, type WorkerConfigurationManagerOptions } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";

const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const projectId = "11111111-1111-4111-8111-111111111111";
const future = '{"boolean":true,"nil":null,"array":[-1.25,1e100000000000000000000,900719925474099312345],"__proto__":{"future":false}}';
const desired = (revision: string, extra = future) => receiveWorkerDesired(`{"revision":"${revision}","updatedAt":"2026-11-17T00:00:00Z","value":{"agentControlMode":"web","maxConcurrent":2,"pollIntervalMs":1200,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[],"future":${extra}},"projects":[{"projectId":"${projectId}","nativeOverrides":{"future":${extra}},"future":${extra}}],"toolPaths":{"codex":{"kind":"auto","future":${extra}},"copilot":{"kind":"auto"},"herdr":{"kind":"auto"},"future":${extra}},"future":${extra}},"future":${extra}}`);
const legacyCheckpoint = (cache: WorkerConfigurationCache) => {
  const recordId = "99999999-9999-4999-8999-999999999999", revision = cache.authority.applicationRevision!;
  const items = (entries: WorkerConfigurationCache["currentItems"]) => entries.filter(item => item.value.key.kind !== "agentControlMode").map(item => ({ ...item, nativeMode: (item.value.key.kind === "native" || item.value.key.kind === "projectNative") && item.value.appliedValue !== null ? "web" : null }));
  const mode = { recordId, origin: { generation: cache.authority.generation, targetRevision: revision, source: "application" },
    value: { key: { kind: "agentControlMode" }, targetRevision: revision, appliedValue: "web", state: "applied", error: null, lastFailure: null, nextAttemptAt: null },
    backoffStep: 0, failureId: null, started: false, nativeMode: null,
    actualSource: { kind: "observed", recordId, generation: cache.authority.generation, targetRevision: revision }, blockedByRemovalId: null };
  const { pendingApplication: _pendingApplication, ...authority } = cache.authority;
  return { ...cache, authority, currentItems: [...items(cache.currentItems), mode], retainedItems: items(cache.retainedItems) };
};
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
  it("preserves unreadable raw authority and unacknowledged removal across GET, restart and later recovery", async () => {
    const apply = vi.fn(async () => {}), remove = vi.fn(async () => { throw new Error("original stop remains unconfirmed"); });
    const first = await fixture({ applyNative: apply });
    await first.manager.configureProjectAdapters({ prepare: async () => {}, remove });
    const initial = desired("1");
    await first.manager.receive(initial, "0"); await first.manager.settle();
    expect(first.manager.current().effective.native).toEqual(initial.known!.value.native);
    expect(first.manager.current().effective.projects[0]?.ready).toBe(true);
    const removed = receiveWorkerDesired(desired("2").json.replace(/"projects":\[.*?\],"toolPaths":/, '"projects":[],"toolPaths":'));
    await first.manager.receive(removed, "0"); await first.manager.settle();
    const before = await first.read();
    const failed = [...before.currentItems, ...before.retainedItems].find(item => item.value.key.kind === "projectRemoval" && item.failureId !== null);
    expect(failed).toMatchObject({ started: true, value: { state: "error", lastFailure: expect.anything() } });
    const applyCount = apply.mock.calls.length;
    const oldReport = first.manager.report();
    expect(oldReport.observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId }, lastFailure: expect.anything() }));
    const unknownJson = desired("3").json.replace('"maxConcurrent":2', '"maxConcurrent":"future-value"');
    const resource = parseReceivedWorkerConfigurationResource({ json: `{"desired":${unknownJson},"observationRevision":"0","observation":null}` });
    expect(resource.desired).toMatchObject({ revision: "3", known: null, json: unknownJson });
    const bootstrap = { prepare: vi.fn(async () => initial.known!.value), clear: vi.fn(async () => {}), invalidate: vi.fn() };
    const exchange = createWorkerConfigurationExchange({ manager: first.manager, read: async () => resource, send: async () => { throw new Error("no report should be sent"); }, bootstrap });
    const operation = createOperation();
    try {
      await exchange.prepare!(operation);
      const saved = await first.read();
      expect(saved.authority.desiredJson).toBe(unknownJson);
      expect(saved.authority.applicationRevision).toBe("2");
      expect(first.manager.current()).toMatchObject({ desired: null, desiredRevision: "3", synchronized: false, selectedProjects: null, toolTargets: null });
      expect(first.manager.hasAuthority()).toBe(true);
      expect(exchange.source!()).toMatchObject({ state: "initialized", desiredRevision: "3" });
      expect(exchange.capture({ ...workerTelemetry, taskInventory: null })).toMatchObject({ bootstrap: null, observation: null, toolPathsBootstrap: null });
      expect(bootstrap.prepare).not.toHaveBeenCalled();
      expect(apply).toHaveBeenCalledTimes(applyCount);
      expect([...saved.currentItems, ...saved.retainedItems]).toContainEqual(failed);
      expect(await first.manager.acknowledge(oldReport, receipt(removed, "1", true))).toBe("ignored");
      expect(await first.read()).toEqual(saved);
      await exchange.close(); await first.manager.stop();

      const reopened = await fixture({ file: first.file, applyNative: apply });
      const reopenedExchange = createWorkerConfigurationExchange({ manager: reopened.manager, read: async () => resource, send: async () => { throw new Error("no report should be sent"); }, bootstrap });
      try {
        expect((await reopened.read()).authority.desiredJson).toBe(unknownJson);
        expect(reopened.manager.current()).toMatchObject({ desired: null, desiredRevision: "3", synchronized: false });
        await reopenedExchange.prepare!(operation);
        expect(reopenedExchange.source!()).toMatchObject({ state: "initialized", desiredRevision: "3" });
        expect(reopenedExchange.capture({ ...workerTelemetry, taskInventory: null })).toMatchObject({ bootstrap: null, observation: null, toolPathsBootstrap: null });
        expect(bootstrap.prepare).not.toHaveBeenCalled();
        expect(apply).toHaveBeenCalledTimes(applyCount);
        expect([...(await reopened.read()).currentItems, ...(await reopened.read()).retainedItems]).toContainEqual(failed);
        const valid = desired("4");
        await reopened.manager.receive(valid, "0"); await reopened.manager.settle();
        const restored = await reopened.read();
        expect(restored.authority.desiredJson).toBe(valid.json);
        expect(reopened.manager.current().desiredRevision).toBe("4");
        expect([...restored.currentItems, ...restored.retainedItems]).toContainEqual(failed);
      } finally { await reopenedExchange.close(); }
    } finally { operation.dispose(); }
  });

  it("reidentifies an unknown sudo target in schema 7 without losing an applied archive choice", async () => {
    const first = await fixture();
    const target = receiveWorkerDesired(desired("1").json.replace('"value":{', '"value":{"archiveSessions":false,"enableSudoCleanup":true,'));
    await first.manager.receive(target, "0"); await first.manager.settle();
    const original = await first.read(); await first.manager.stop();
    const historical = legacyCheckpoint(original);
    const source = { ...historical, schemaVersion: 7,
      currentItems: historical.currentItems.filter(item => item.value.key.kind !== "enableSudoCleanup"),
      retainedItems: historical.retainedItems.filter(item => item.value.key.kind !== "enableSudoCleanup") };
    await writeFile(first.file, JSON.stringify(source));
    const second = await fixture({ file: first.file });
    expect(second.manager.readCleanupPolicy()).toBeNull();
    expect(second.manager.current().retainedArchiveSessions).toBe(false);
    const migrated = await second.read();
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.currentItems.find(item => item.value.key.kind === "enableSudoCleanup")?.value).toMatchObject({ state: "pending", appliedValue: null });
    await second.manager.receive(target, "0"); await second.manager.settle();
    expect(second.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "1" });
    expect(second.manager.current().effective.archiveSessions).toBe(false);
  });

  it("reidentifies a schema 6 unknown sudo target before application and preserves actual sources", async () => {
    const first = await fixture(), initial = desired("1");
    await first.manager.receive(initial, "0"); await first.manager.settle();
    const old = await first.read();
    await first.manager.stop();
    const source = { ...legacyCheckpoint(old), schemaVersion: 6, authority: { ...legacyCheckpoint(old).authority, desiredJson: initial.json.replace('"revision":"1"', '"revision":"2"').replace('"value":{', '"value":{"enableSudoCleanup":true,') } };
    await writeFile(first.file, JSON.stringify(source));
    const second = await fixture({ file: first.file });
    const migrated = await second.read();
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.authority.applicationRevision).toBe("2");
    expect(migrated.authority.generation).not.toBe(old.authority.generation);
    expect(migrated.retainedItems).toEqual(expect.arrayContaining(old.currentItems.filter(item => item.value.key.kind !== "agentControlMode")));
    expect(migrated.currentItems.find(item => item.value.key.kind === "agentControlMode")).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    const sudo = migrated.currentItems.find(item => item.value.key.kind === "enableSudoCleanup");
    expect(sudo?.value).toMatchObject({ state: "pending", appliedValue: null, targetRevision: "2" });
    expect(second.manager.readCleanupPolicy()).toBeNull();
    for (const original of old.currentItems.filter(item => item.value.key.kind !== "agentControlMode" && item.value.appliedValue !== null)) {
      const current = migrated.currentItems.find(item => JSON.stringify(item.value.key) === JSON.stringify(original.value.key));
      expect(current?.value.appliedValue).toEqual(original.value.appliedValue);
      expect(current?.actualSource).toEqual(original.actualSource);
    }
    await second.manager.receive(receiveWorkerDesired(source.authority.desiredJson), "0");
    await second.manager.settle();
    expect(second.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "2" });
    await second.manager.stop();
    const offline = await fixture({ file: first.file });
    expect(offline.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "2" });
    await offline.manager.receive(receiveWorkerDesired(source.authority.desiredJson.replace('"revision":"2"', '"revision":"3"').replace('"enableSudoCleanup":true', '"enableSudoCleanup":false')), "0");
    await offline.manager.settle();
    expect(offline.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: false, revision: "3" });
  });

  it("does not publish or overwrite schema 6 when migration persistence fails", async () => {
    const first = await fixture(), initial = desired("1");
    await first.manager.receive(initial, "0"); await first.manager.settle();
    const old = await first.read(); await first.manager.stop();
    const source = JSON.stringify({ ...legacyCheckpoint(old), schemaVersion: 6, authority: { ...legacyCheckpoint(old).authority, desiredJson: initial.json.replace('"value":{', '"value":{"enableSudoCleanup":true,') } });
    await writeFile(first.file, source);
    const failure = new Error("migration write failed");
    await expect(createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {}, persist: async () => { throw failure; } })).rejects.toBe(failure);
    expect(await readFile(first.file, "utf8")).toBe(source);
  });

  it("validates newly recognized remote observations before replacing schema 6", async () => {
    const first = await fixture(), initial = desired("1");
    await first.manager.receive(initial, "0"); await first.manager.settle();
    const old = await first.read(); await first.manager.stop();
    const observation = '{"baseRevision":"0","desiredRevision":"1","reportedAt":"2026-11-17T00:00:00Z","items":[{"key":{"kind":"enableSudoCleanup"},"targetRevision":"1","appliedValue":"invalid","state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}';
    const source = JSON.stringify({ ...legacyCheckpoint(old), schemaVersion: 6, remoteObservation: { observationRevision: "1", json: observation } });
    await writeFile(first.file, source);
    await expect(createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow();
    expect(await readFile(first.file, "utf8")).toBe(source);
  });

  it("rejects an invalid newly known sudo value and leaves a schema 6 file intact", async () => {
    const first = await fixture(), initial = desired("1");
    await first.manager.receive(initial, "0"); await first.manager.settle();
    const old = await first.read(); await first.manager.stop();
    const source = JSON.stringify({ ...legacyCheckpoint(old), schemaVersion: 6, authority: { ...legacyCheckpoint(old).authority, desiredJson: initial.json.replace('"value":{', '"value":{"enableSudoCleanup":null,') } });
    await writeFile(first.file, source);
    await expect(createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow();
    expect(await readFile(first.file, "utf8")).toBe(source);
  });

  it("keeps the previous policy until the new scalar has been committed", async () => {
    let blockScalar = false;
    const entered = barrier(), release = barrier();
    const first = await fixture({ persist: async (file, chunks) => {
      const text = [...chunks()].join("");
      const parsed = JSON.parse(text) as WorkerConfigurationCache;
      if (blockScalar && parsed.currentItems.some(item => item.value.key.kind === "enableSudoCleanup" && item.value.appliedValue === false)) {
        blockScalar = false; entered.resolve(); await release.promise;
      }
      await replaceFileAtomicallyFromChunks(file, [text], 0o600);
    } });
    const initial = receiveWorkerDesired(desired("1").json.replace('"value":{', '"value":{"enableSudoCleanup":true,'));
    await first.manager.receive(initial, "0"); await first.manager.settle();
    expect(first.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "1" });
    blockScalar = true;
    try {
      await first.manager.receive(receiveWorkerDesired(initial.json.replace('"revision":"1"', '"revision":"2"').replace('"enableSudoCleanup":true', '"enableSudoCleanup":false')), "0");
      await entered.promise;
      expect(first.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "1" });
    } finally { release.resolve(); }
    await first.manager.settle();
    expect(first.manager.readCleanupPolicy()).toEqual({ enableSudoCleanup: false, revision: "2" });
  });

  it("retains a hidden negotiated projection across restart without executing it", async () => {
    const first = await fixture(), rich = desired("1");
    const tools = desiredCapabilitySources(rich.json).get("toolPaths")!;
    const legacy = receiveWorkerDesired(rich.json.replace(`,"toolPaths":${tools}`, "").replace('"agentControlMode":"web",', ""));
    await first.manager.receive(rich, "0"); await first.manager.settle();
    await first.manager.receive(legacy, "0"); await first.manager.settle();
    const saved = await first.read();
    expect(saved.authority.desiredJson).toBe(legacy.json);
    expect(saved.hiddenCapabilitySources).toEqual({ agentControlMode: { revision: "1", json: '"web"' }, toolPaths: { revision: "1", json: tools } });
    expect(first.manager.current().desired!.value.toolPaths).toBeUndefined();
    expect(first.manager.current().desired!.value.agentControlMode).toBeUndefined();
    expect(JSON.stringify(first.manager.report())).not.toContain("future");
    expect(first.manager.report().observation).toBeNull();
    await first.manager.stop();
    const second = await fixture({ file: first.file });
    expect((await second.read()).hiddenCapabilitySources).toEqual(saved.hiddenCapabilitySources);
    await second.manager.receive(legacy, "0"); await second.manager.settle();
    expect(second.manager.current().desired!.value.toolPaths).toBeUndefined();
    await second.manager.receive(rich, "0"); await second.manager.settle();
    const restored = await second.read();
    expect(restored.authority.desiredJson).toBe(rich.json);
    expect(restored.hiddenCapabilitySources).toBeUndefined();
    expect(second.manager.current().desired!.value.toolPaths).toEqual(rich.known!.value.toolPaths);
    expect(second.manager.current().desired!.value.agentControlMode).toBe("web");
  });

  it("streams a large hidden future subtree through the checkpoint", async () => {
    const first = await fixture(), base = desired("1"), initialTools = desiredCapabilitySources(base.json).get("toolPaths")!;
    const largeTools = initialTools.replace(`"future":${future}`, `"future":{"payload":"${"x".repeat(131_072)}"}`);
    const rich = receiveWorkerDesired(base.json.replace(initialTools, largeTools));
    const legacy = receiveWorkerDesired(rich.json.replace(`,"toolPaths":${largeTools}`, ""));
    await first.manager.receive(rich, "0"); await first.manager.settle();
    await first.manager.receive(legacy, "0"); await first.manager.settle();
    await first.manager.stop();
    const second = await fixture({ file: first.file });
    expect((await second.read()).hiddenCapabilitySources?.toolPaths?.json).toBe(largeTools);
    await second.manager.receive(legacy, "0"); await second.manager.receive(rich, "0");
    expect(second.manager.current().desired!.value.toolPaths).toEqual(rich.known!.value.toolPaths);
  });

  it("rejects changes to a previously hidden subtree at the same revision", async () => {
    const first = await fixture(), rich = desired("1"), tools = desiredCapabilitySources(rich.json).get("toolPaths")!;
    const legacy = receiveWorkerDesired(rich.json.replace(`,"toolPaths":${tools}`, ""));
    await first.manager.receive(rich, "0"); await first.manager.settle();
    await first.manager.receive(legacy, "0"); await first.manager.settle();
    const before = await first.read();
    const changed = receiveWorkerDesired(rich.json.replace(tools, tools.replace("900719925474099312345", "900719925474099312346")));
    await expect(first.manager.receive(changed, "0")).rejects.toThrow();
    expect(await first.read()).toEqual(before);
    managers.splice(managers.indexOf(first.manager), 1);
    await expect(first.manager.stop()).rejects.toThrow();
  });

  it("keeps the original source and error when a hidden projection cannot be persisted", async () => {
    let armed = false;
    const failure = new Error("hidden projection checkpoint failed");
    const first = await fixture({ persist: async (file, chunks) => {
      if (armed) throw failure;
      await replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
    } });
    const rich = desired("1"), tools = desiredCapabilitySources(rich.json).get("toolPaths")!;
    const legacy = receiveWorkerDesired(rich.json.replace(`,"toolPaths":${tools}`, ""));
    await first.manager.receive(rich, "0"); await first.manager.settle();
    const before = await first.read(); armed = true;
    await expect(first.manager.receive(legacy, "0")).rejects.toBe(failure);
    expect(await first.read()).toEqual(before);
    expect(first.manager.current().desired!.value.toolPaths).toEqual(rich.known!.value.toolPaths);
    managers.splice(managers.indexOf(first.manager), 1);
    await expect(first.manager.stop()).rejects.toBe(failure);
  });

  it("does not assign a hidden old revision to a newer or reset authority", async () => {
    const first = await fixture(), rich = desired("1"), tools = desiredCapabilitySources(rich.json).get("toolPaths")!;
    const legacy = receiveWorkerDesired(rich.json.replace(`,"toolPaths":${tools}`, ""));
    await first.manager.receive(rich, "0"); await first.manager.settle();
    await first.manager.receive(legacy, "0"); await first.manager.settle();
    const legacyNewer = receiveWorkerDesired(legacy.json.replace('"revision":"1"', '"revision":"2"'));
    await first.manager.receive(legacyNewer, "0"); await first.manager.settle();
    expect((await first.read()).hiddenCapabilitySources?.toolPaths).toEqual({ revision: "1", json: tools });
    const newer = receiveWorkerDesired(rich.json.replace('"revision":"1"', '"revision":"2"').replace(tools, tools.replace("900719925474099312345", "900719925474099312346")));
    await first.manager.receive(newer, "0"); await first.manager.settle();
    expect((await first.read()).hiddenCapabilitySources).toBeUndefined();
    expect(first.manager.current().desired!.revision).toBe("2");
    await first.manager.receive(legacy, "0"); await first.manager.settle();
    expect((await first.read()).hiddenCapabilitySources).toBeUndefined();
  });
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
    const entered = barrier(), release = barrier(), prepare = vi.fn<NonNullable<WorkerConfigurationManagerOptions["prepareToolSelection"]>>(async (_native, targets, signal) => {
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
