import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import { createWorkerConfigurationPersistence } from "../../../src/commands/worker/configuration-persistence.js";
import { parseConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";
import { decodeWorkerCloudJsonSource, parseReceivedWorkerConfigurationResource, parseWorkerCloudDesired, receiveWorkerDesired } from "../../../src/api/worker-configuration.js";
import { transitionConfigurationDesired } from "../../../src/commands/worker/configuration-state.js";

const uuid = (n: number): string => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const identity = { serverOrigin: "https://daynight.example", userId: uuid(1), workerId: uuid(2) };
const generation = uuid(3), projectId = uuid(4);
const native = { agent: "codex", model: null, args: [] };
const desired = { revision: "10", updatedAt: "2026-11-04T00:00:00Z", value: { agentControlMode: "web", toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } }, maxConcurrent: 4, pollIntervalMs: 1500, recoveryLimit: 2, preferPlatformSpecificTasks: false, native, projects: [{ projectId, nativeOverrides: {} }] } };
const failure = { code: "permission_denied", category: "runtime", phase: "stop", occurredAt: "2026-11-04T01:00:00Z" };
const record = (n: number, kind: string, appliedValue: unknown, mode: string | null = null) => ({
  recordId: uuid(n), origin: { generation, targetRevision: "10", source: "application" },
  value: { key: kind.startsWith("project") ? { kind, projectId } : { kind }, targetRevision: "10", appliedValue, state: "applied", error: null, lastFailure: null, nextAttemptAt: null },
  backoffStep: 0, failureId: null, started: false, nativeMode: mode,
  actualSource: { kind: "observed", recordId: uuid(n), generation, targetRevision: "10" }, blockedByRemovalId: null,
});
const old5 = () => ({ schemaVersion: 5, identity, authority: { generation, desired, observationRevision: "8" }, nextFailureId: 7, projectionCursor: uuid(90), currentItems: [
  record(10, "maxConcurrent", 4), record(11, "pollIntervalMs", 1500), record(12, "recoveryLimit", 2), record(13, "preferPlatformSpecificTasks", false), record(14, "native", native, "web"), record(15, "agentControlMode", "web"),
  { ...record(16, "projectPreparation", true), blockedByRemovalId: uuid(18) }, record(17, "projectNative", native, "herdr"),
], retainedItems: [{ ...record(18, "projectRemoval", true), started: true, backoffStep: 2, failureId: 6, value: { ...record(18, "projectRemoval", true).value, state: "error", error: failure, lastFailure: failure, nextAttemptAt: "2026-11-04T01:00:10Z" } }] });

describe("Web configuration checkpoint", () => {
  it("preserves source and removal responsibility when upgrading old facts", () => {
    const source = old5(), result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache).toMatchObject({ schemaVersion: 6, format: "web", nextFailureId: 7, projectionCursor: null, authority: { observationRevision: "8", applicationRevision: "10" } });
    expect(result.cache.authority.generation).not.toBe(generation);
    expect(JSON.parse(result.cache.authority.desiredJson!)).toEqual(desired);
    expect(result.cache.currentItems.some(item => item.value.key.kind === ("agentControlMode" as string))).toBe(false);
    expect(result.cache.currentItems.find(item => item.recordId === uuid(14))).toMatchObject({ value: { state: "applied", appliedValue: native } });
    expect(result.cache.currentItems.find(item => item.recordId === uuid(17))).toMatchObject({ value: { state: "pending", appliedValue: null, error: null, lastFailure: null, nextAttemptAt: null }, actualSource: null, failureId: null, backoffStep: 0 });
    expect(result.cache.currentItems.find(item => item.recordId === uuid(16))?.blockedByRemovalId).toBe(uuid(18));
    expect(result.cache.retainedItems[0]).toMatchObject({ recordId: uuid(18), started: true, backoffStep: 2, failureId: 6, value: { state: "error", lastFailure: failure } });
    expect(parseConfigurationCache(result.cache, identity)).toEqual({ cache: result.cache, migrated: false });
  });

  it("invalidates an old projection while preserving facts for an unsupported new target", () => {
    const original = parseConfigurationCache(old5(), identity).cache;
    const newer = receiveWorkerDesired(JSON.stringify({ ...desired, revision: "11" }));
    const next = transitionConfigurationDesired(original, newer, new Set(), () => uuid(30));
    expect(next.authority).toMatchObject({ generation: uuid(30), applicationRevision: "10" });
    expect(JSON.parse(next.authority.desiredJson!).revision).toBe("11");
    expect(next.currentItems).toEqual(original.currentItems);
    expect(next.retainedItems).toEqual(original.retainedItems);
    expect(parseConfigurationCache(next, identity).cache).toEqual(next);
  });

  it("upgrades the previously deployed version 6 without losing its raw target", () => {
    const old = old5();
    const raw = JSON.stringify({ ...desired, value: { ...desired.value, future: { arbitrary: -1.25 } } });
    const source = { schemaVersion: 6, identity, authority: { generation, desiredJson: raw, applicationRevision: "10", observationRevision: "8" }, remoteObservation: null, nextFailureId: old.nextFailureId, projectionCursor: old.projectionCursor, currentItems: old.currentItems, retainedItems: old.retainedItems };
    const result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache.authority.desiredJson).toBe(raw);
    expect(parseConfigurationCache(result.cache, identity).migrated).toBe(false);
    expect(() => parseConfigurationCache({ ...source, format: "unexpected" }, identity)).toThrow();
  });

  it("rebuilds active items only after the raw target is repaired", () => {
    const old = parseConfigurationCache(old5(), identity).cache;
    const corrected = receiveWorkerDesired(JSON.stringify({ revision: "11", updatedAt: desired.updatedAt, value: { ...desired.value, agentControlMode: undefined, toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } } } }));
    let nextId = 40;
    const next = transitionConfigurationDesired(old, corrected, new Set(), () => uuid(nextId++));
    expect(next.authority).toMatchObject({ generation: uuid(40), applicationRevision: "11" });
    expect(next.currentItems.find(item => item.value.key.kind === "projectPreparation")).toMatchObject({ blockedByRemovalId: uuid(18) });
    expect(next.retainedItems.find(item => item.recordId === uuid(18))).toMatchObject({ started: true, failureId: 6 });
    expect(parseConfigurationCache(next, identity).cache).toEqual(next);
  });


  it("publishes storage readiness only after the migrated file is saved", async () => {
    const root = path.resolve("../../.tmp/configuration-web-cache-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json");
    const source = JSON.stringify(old5());
    const controller = new AbortController();
    try {
      await writeFile(file, source);
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const saving = new Promise<void>(resolve => { entered = resolve; });
      let ready = false;
      const creating = createWorkerConfigurationPersistence({ file, identity, signal: controller.signal, persist: async (target, chunks) => {
        entered(); await waiting; await replaceFileAtomicallyFromChunks(target, chunks(), 0o600);
      } }).then(storage => { ready = true; return storage; });
      await saving;
      expect(ready).toBe(false);
      expect(await readFile(file, "utf8")).toBe(source);
      release();
      const storage = await creating;
      expect(storage.isReady()).toBe(true);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 6, format: "web" });
      await storage.finish();
    } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
  });


  it("reads an unsupported target, then applies its explicit correction and rejects a late projection", async () => {
    const root = path.resolve("../../.tmp/configuration-web-cache-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json");
    const controller = new AbortController();
    const applied: unknown[] = [], invalid: string[] = [];
    try {
      await writeFile(file, JSON.stringify(old5()));
      const manager = await createWorkerConfigurationManager({ file, identity, signal: controller.signal, applyNative: async value => { applied.push(value); }, onInvalidDesired: revision => { invalid.push(revision); } });
      await manager.receive(receiveWorkerDesired(JSON.stringify(desired)), "8");
      await manager.settle();
      expect(invalid).toEqual(["10"]);
      expect(manager.current().effective.native).toBeNull();
      expect(manager.current().projects).toEqual({ selected: null, tracked: [projectId] });
      expect(applied).toEqual([]);
      const prior = manager.report();
      expect(prior).toMatchObject({ bootstrap: null, toolPathsBootstrap: null, observation: null });
      const corrected = { revision: "11", updatedAt: desired.updatedAt, value: { ...desired.value, agentControlMode: undefined, toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } } } };
      await manager.receive(receiveWorkerDesired(JSON.stringify(corrected)), "8");
      const receiptJson = JSON.stringify({ desired: corrected, observationRevision: "8", observationAccepted: false });
      expect(await manager.acknowledge(prior, { json: receiptJson, desired: receiveWorkerDesired(JSON.stringify(corrected)), observationRevision: "8", observationAccepted: false })).toBe("ignored");
      await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
      await manager.settle();
      expect(manager.current().projects.selected).toEqual([projectId]);
      expect(manager.current().effective.native).toEqual(native);
      expect(applied).toContainEqual(native);
      await manager.stop();
    } finally { controller.abort(); await rm(directory, { recursive: true, force: true }); }
  });


  it("reads the actual old cloud target without accepting it as a new candidate", () => {
    const raw = JSON.stringify({ desired, observationRevision: "0", observation: null });
    const resource = parseReceivedWorkerConfigurationResource(decodeWorkerCloudJsonSource(raw));
    expect(resource.desired?.known).toEqual(desired);
    expect(resource.desired?.json).toBe(JSON.stringify(desired));
    expect(() => parseWorkerCloudDesired(resource.desired!.known)).toThrow();
  });

});
