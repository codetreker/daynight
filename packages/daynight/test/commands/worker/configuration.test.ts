import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationManagerOptions, WorkerConfigurationSnapshot } from "../../../src/commands/worker/configuration.js";
import { parseWorkerCloudReport } from "../../../src/api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudNative } from "../../../src/api/worker-configuration.js";
import { replaceFileAtomically } from "../../../src/platform/files.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const desired = (revision = "1", model = "original", projects = true): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-04T00:00:00Z", value: { maxConcurrent: Number(revision) + 1, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: { agent: "codex", model, args: [] }, projects: projects ? [{ projectId, nativeOverrides: {} }] : [] } });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const fixtures: { manager: WorkerConfigurationManager; directory: string; expectedStopError?: unknown }[] = [];
const item = (snapshot: WorkerConfigurationSnapshot, kind: WorkerCloudItem["key"]["kind"]): WorkerCloudItem | undefined => snapshot.items.find(value => value.key.kind === kind);
const fixture = async (overrides: Partial<WorkerConfigurationManagerOptions> = {}) => {
  const root = path.resolve(".tmp/worker-cloud-configuration-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json"), listeners = new Set<() => void>();
  const manager = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {}, now: () => Date.now(), ...overrides, onChange: snapshot => { overrides.onChange?.(snapshot); for (const listener of listeners) listener(); } });
  fixtures.push({ manager, directory });
  const wait = (predicate: (snapshot: WorkerConfigurationSnapshot) => boolean): Promise<void> => {
    if (predicate(manager.current())) return Promise.resolve();
    return new Promise(resolve => {
      const listener = () => { if (predicate(manager.current())) { listeners.delete(listener); resolve(); } };
      listeners.add(listener);
    });
  };
  return { manager, directory, file, wait };
};
afterEach(async () => {
  vi.useRealTimers();
  const failures: unknown[] = [], active = fixtures.splice(0);
  for (const { manager, expectedStopError } of active) {
    try { await manager.stop(); } catch (error) { if (error !== expectedStopError) failures.push(error); }
  }
  for (const directory of new Set(active.map(fixture => fixture.directory))) await rm(directory, { recursive: true, force: true });
  if (failures.length !== 0) throw new AggregateError(failures, "Configuration fixture shutdown failed.");
});

describe("Worker cloud configuration application", () => {
  it("hot-applies platform preference in both directions and reports false as an applied value", async () => {
    const { manager } = await fixture();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBeNull();
    const first = desired("1", "original", false);
    await manager.receive({ ...first, value: { ...first.value, preferPlatformSpecificTasks: true } });
    await manager.settle();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBe(true);
    await manager.receive(desired("2", "original", false));
    await manager.settle();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBe(false);
    expect(item(manager.current(), "preferPlatformSpecificTasks")).toMatchObject({ state: "applied", appliedValue: false, targetRevision: "2" });
    expect(parseWorkerCloudReport(manager.report()).observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "preferPlatformSpecificTasks" }, appliedValue: false }));
  });

  it("atomically migrates a full schema-1 cache without discarding removal or failure ownership", async () => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(target); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    saved.schemaVersion = 1;
    delete saved.desired.value.preferPlatformSpecificTasks;
    saved.items = saved.items.filter((entry: { value: WorkerCloudItem }) => entry.value.key.kind !== "preferPlatformSpecificTasks");
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    for (let n = 0; n < 1020; n++) saved.items.push({ value: {
      key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null,
      state: n === 0 ? "error" : "pending", error: n === 0 ? failure : null, lastFailure: n === 0 ? failure : null, nextAttemptAt: null,
    }, attempts: n === 0 ? 2 : 0, failureId: n === 0 ? 1 : null, started: n === 0 });
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    const migrated = JSON.parse(await readFile(first.file, "utf8"));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.desired).toEqual({ ...saved.desired, value: { ...saved.desired.value, preferPlatformSpecificTasks: false } });
    expect(migrated.nextFailureId).toBe(saved.nextFailureId);
    expect(migrated.observationRevision).toBe(saved.observationRevision);
    expect(migrated.items.filter((entry: { value: WorkerCloudItem }) => entry.value.key.kind !== "preferPlatformSpecificTasks")).toEqual(saved.items);
    expect(item(reopened.current(), "preferPlatformSpecificTasks")).toMatchObject({ state: "pending", appliedValue: null });
    expect(reopened.current().effective.preferPlatformSpecificTasks).toBeNull();
    await reopened.receive(target); await reopened.settle();
    expect(reopened.current().effective.preferPlatformSpecificTasks).toBe(false);
    expect(parseWorkerCloudReport(reopened.report()).observation?.items).toHaveLength(1025);
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "error", lastFailure: failure });
  });

  it("rejects a missing preference in a current cache without rewriting it", async () => {
    const first = await fixture();
    await first.manager.receive(desired("1", "original", false)); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    delete saved.desired.value.preferPlatformSpecificTasks;
    const source = JSON.stringify(saved);
    await writeFile(first.file, source);
    await expect(createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow();
    expect(await readFile(first.file, "utf8")).toBe(source);
  });
  it.each([false, true])("preserves removal ownership when a full cache defers a target reselecting the Project (started=%s)", async started => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(target); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    saved.items.push({ value: { key: { kind: "projectRemoval", projectId }, targetRevision: "1", appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    for (let n = 0; n < 1019; n++) saved.items.push({ value: { key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null, state: "error", error: failure, lastFailure: failure, nextAttemptAt: retryAt }, attempts: 1, failureId: n + 1, started: true });
    saved.nextFailureId = 1020;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    const next = desired("2"), expanded = { ...next, value: { ...next.value, projects: [...next.value.projects, { projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: {} }] } };
    await reopened.receive(expanded);
    const remove = vi.fn(async () => {});
    await reopened.configureProjectAdapters({ remove }); await reopened.settle();
    expect(reopened.current().synchronized).toBe(false);
    if (started) {
      expect(remove).toHaveBeenCalledExactlyOnceWith(projectId, expect.any(AbortSignal));
      expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "applied", appliedValue: true });
    } else {
      expect(remove).not.toHaveBeenCalled();
      expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "pending", appliedValue: null });
    }
  });
  it("retains an invalid historical target without executing it and resumes with a valid newer target", async () => {
    const invalid = { ...desired("1", "original", false), value: { ...desired("1", "original", false).value, maxConcurrent: 65 } };
    const onInvalidDesired = vi.fn(), applyNative = vi.fn(async () => {});
    const { manager } = await fixture({ onInvalidDesired, applyNative });
    await manager.receive(invalid); await manager.settle();
    expect(manager.current().synchronized).toBe(false);
    expect(manager.current().desired).toBeNull();
    expect(applyNative).not.toHaveBeenCalled();
    const sent = manager.report();
    await manager.acknowledge(sent, { desired: invalid, observationRevision: "0", observationAccepted: false });
    expect(onInvalidDesired).toHaveBeenCalledOnce();
    await manager.receive(desired("2", "original", false)); await manager.settle();
    expect(manager.current().effective.maxConcurrent).toBe(3);
    expect(applyNative).toHaveBeenCalled();
  });
  it("reloads legacy over-limit cache structurally and applies a valid newer target without discarding failures", async () => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(target); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    saved.desired.value.maxConcurrent = 65;
    saved.items.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "maxConcurrent").value.appliedValue = 65;
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    saved.items.push({ value: { key: { kind: "projectRemoval", projectId }, targetRevision: "1", appliedValue: null, state: "error", error: failure, lastFailure: failure, nextAttemptAt: null }, attempts: 1, failureId: 1, started: true });
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "original", false)); await reopened.settle();
    expect(reopened.current().effective.maxConcurrent).toBe(3);
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "error", lastFailure: failure });
    expect(reopened.report().observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId }, lastFailure: failure }));
  });
  it("cancels obsolete in-flight preparation while a newer target waits for capacity", async () => {
    const first = await fixture();
    await first.manager.receive(desired()); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    for (let n = 0; n < 1018; n++) saved.items.push({ value: { key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started: false });
    await writeFile(first.file, JSON.stringify(saved));
    const entered = deferred(), released = deferred(), cancelled = deferred();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.configureProjectAdapters({ prepare: async (_id, signal) => { signal.addEventListener("abort", () => cancelled.resolve(), { once: true }); entered.resolve(); await released.promise; } });
    await reopened.receive(desired()); await entered.promise;
    const next = desired("2", "original", false);
    await reopened.receive({ ...next, value: { ...next.value, projects: [{ projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: {} }] } });
    await cancelled.promise;
    released.resolve(); await reopened.settle();
    expect(reopened.current().synchronized).toBe(false);
    expect(item(reopened.current(), "projectPreparation")).toMatchObject({ state: "pending", appliedValue: null });
  });
  it("retains unacknowledged items at capacity, rejects growth atomically and converges after a matching receipt and restart", async () => {
    const first = await fixture();
    const target = desired("1", "original", false);
    await first.manager.receive(target);
    await first.manager.settle();
    await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    for (let n = 0; n < 1020; n++) {
      const state = n === 0 || n === 2 ? "applied" : n === 1 ? "error" : "pending";
      saved.items.push({ value: { key: { kind: "projectRemoval", projectId: id(n) }, targetRevision: "1", appliedValue: state === "applied" ? true : null, state, error: n === 1 ? failure : null, lastFailure: n === 1 ? failure : null, nextAttemptAt: null }, attempts: 0, failureId: n === 1 ? 1 : null, started: n === 0 || n === 1 });
    }
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const next = { ...desired("2", "original", false), value: { ...target.value, projects: [{ projectId: id(0), nativeOverrides: {} }] } };
    const onCapacity = vi.fn();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {}, onCapacity });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(next);
    await reopened.settle();
    expect(reopened.current().items).toHaveLength(1025);
    const before = await readFile(first.file, "utf8");
    await expect(reopened.ensureProjectRemoval(id(1021))).rejects.toThrow("capacity");
    await reopened.receive(next);
    expect(await readFile(first.file, "utf8")).toBe(before);
    expect(reopened.current().synchronized).toBe(false);
    expect(reopened.current().desired?.revision).toBe("1");
    expect(onCapacity).toHaveBeenCalledOnce();
    const unknown = reopened.report();
    await reopened.acknowledge(unknown, { desired: next, observationRevision: "0", observationAccepted: false });
    expect(reopened.current().items).toHaveLength(1025);
    expect(reopened.current().items.find(item => item.key.kind === "projectRemoval" && item.key.projectId === id(1))?.lastFailure).toEqual(failure);
    const accepted = reopened.report();
    await reopened.acknowledge(accepted, { desired: next, observationRevision: "1", observationAccepted: true });
    expect(reopened.current().items).toHaveLength(1025);
    expect(reopened.current().desired?.revision).toBe("2");
    expect(reopened.current().synchronized).toBe(true);
    expect(reopened.current().items.some(item => item.key.kind === "projectRemoval" && item.key.projectId === id(0))).toBe(false);
    expect(reopened.current().items.find(item => item.key.kind === "projectRemoval" && item.key.projectId === id(1))).toMatchObject({ state: "error", lastFailure: null });
    await expect(reopened.ensureProjectRemoval(id(1021))).rejects.toThrow("capacity");
  });
  it("applies independent values while native failure and unprepared projects remain truthful", async () => {
    const { manager, file, wait } = await fixture({ applyNative: async () => { throw new Error("secret native arguments must not be reported"); } });
    await manager.receive(desired());
    await wait(snapshot => item(snapshot, "native")?.state === "error" && snapshot.effective.maxConcurrent === 2 && snapshot.effective.pollIntervalMs === 1200 && snapshot.effective.recoveryLimit === 4);
    expect(manager.current().effective).toMatchObject({ maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: null, projects: [{ projectId, ready: false }] });
    expect(item(manager.current(), "projectPreparation")).toMatchObject({ state: "pending", appliedValue: null });
    expect(JSON.stringify(manager.report())).not.toContain("secret native arguments");
    expect(JSON.parse(await readFile(file, "utf8")).desired.revision).toBe("1");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("does not grant readiness from native validation and defers unavailable bindings until reconfigured", async () => {
    const prepare = vi.fn(async () => false as const);
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare });
    await manager.receive(desired());
    await wait(snapshot => item(snapshot, "projectNative")?.state === "applied" && item(snapshot, "projectPreparation")?.state === "pending" && prepare.mock.calls.length === 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    await manager.configureProjectAdapters({ prepare: async () => {} });
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
  });

  it("resolves project inheritance and explicit clears before validating each native tuple", async () => {
    const { manager, wait } = await fixture();
    const current = desired();
    await manager.receive({ ...current, value: { ...current.value, native: { agent: "codex", model: "global", args: ["--global"] }, projects: [
      { projectId, nativeOverrides: { agent: "claude" } },
      { projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: { model: null, args: [] } },
    ] } });
    await wait(snapshot => snapshot.effective.projects.every(project => project.native !== null));
    expect(manager.current().effective.projects).toEqual([
      { projectId, native: { agent: "claude", model: null, args: [] }, ready: false },
      { projectId: "44444444-4444-4444-8444-444444444444", native: { agent: "codex", model: null, args: [] }, ready: false },
    ]);
  });

  it("serializes a paused application write with a newer target without losing either transition", async () => {
    const application = deferred(), writeEntered = deferred(), releaseWrite = deferred();
    let pause = true;
    const { manager, file, wait } = await fixture({ applyNative: async native => { if (native.model === "original") await application.promise; }, persist: async (file, contents) => {
      const cache = JSON.parse(contents);
      if (pause && cache.items.some((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native" && entry.value.state === "applied")) { pause = false; writeEntered.resolve(); await releaseWrite.promise; }
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.receive(desired("1", "original", false));
    await wait(snapshot => snapshot.effective.maxConcurrent === 2);
    application.resolve();
    await writeEntered.promise;
    const receiving = manager.receive(desired("2", "new", false));
    expect(manager.current().desired?.revision).toBe("1");
    releaseWrite.resolve();
    await receiving;
    await wait(snapshot => snapshot.effective.native?.model === "new");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.desired.revision).toBe("2");
    expect(saved.items.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native").value.appliedValue.model).toBe("new");
  });

  it("discards a late superseded native result and converges after its cancellation joins", async () => {
    const oldStarted = deferred(), releaseOld = deferred();
    const { manager, wait } = await fixture({ applyNative: async native => { if (native.model === "old") { oldStarted.resolve(); await releaseOld.promise; } } });
    await manager.receive(desired("1", "old", false));
    await oldStarted.promise;
    await manager.receive(desired("2", "latest", false));
    releaseOld.resolve();
    await wait(snapshot => snapshot.effective.native?.model === "latest");
    expect(item(manager.current(), "native")).toMatchObject({ targetRevision: "2", appliedValue: { model: "latest" }, state: "applied" });
    await manager.receive(desired("1", "old", false));
    expect(manager.current().desired?.revision).toBe("2");
  });

  it("retains recovered failures until accepted and cannot clear a new failure with an older ACK", async () => {
    let failed = true;
    const { manager, wait } = await fixture({ now: () => Date.parse("2026-11-04T00:00:00Z"), applyNative: async () => { if (failed) throw new TypeError("bad args"); } });
    await manager.receive(desired("1", "bad", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const firstReport = manager.report();
    failed = false;
    await manager.receive(desired("2", "recovered", false));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    await manager.acknowledge(firstReport, { desired: desired("2", "recovered", false), observationRevision: "1", observationAccepted: false });
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    expect(manager.report().observation?.baseRevision).toBe("1");
    const recoveredReport = manager.report();
    failed = true;
    await manager.receive(desired("3", "bad-again", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const newFailure = item(manager.current(), "native")?.lastFailure;
    await manager.acknowledge(recoveredReport, { desired: desired("3", "bad-again", false), observationRevision: "2", observationAccepted: true });
    expect(item(manager.current(), "native")?.lastFailure).toEqual(newFailure);
    const latestReport = manager.report();
    await manager.acknowledge(latestReport, { desired: desired("3", "bad-again", false), observationRevision: "3", observationAccepted: true });
    expect(item(manager.current(), "native")?.lastFailure).toBeNull();
    expect(item(manager.current(), "native")?.error).not.toBeNull();
  });

  it("retries failed items with bounded backoff and preserves the successful value", async () => {
    const { manager, wait } = await fixture({ applyNative: async native => { if (native.model === "invalid") throw new Error("provider unavailable"); } });
    await manager.receive(desired("1", "good", false));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    vi.useFakeTimers();
    await manager.receive(desired("2", "invalid", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    expect(manager.current().effective.native?.model).toBe("good");
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const before = item(manager.current(), "native")!;
      expect(Date.parse(before.nextAttemptAt!) - Date.now()).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
      await wait(snapshot => item(snapshot, "native")?.state === "error" && item(snapshot, "native")?.nextAttemptAt !== before.nextAttemptAt);
    }
  });

  it("does not lose an already started project removal when the project is re-added", async () => {
    const removing = deferred(), releaseRemoval = deferred();
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => { removing.resolve(); await releaseRemoval.promise; } });
    await manager.receive(desired("1"));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await manager.receive(desired("2", "original", false));
    expect(manager.current().effective.projects).toEqual([]);
    await removing.promise;
    await manager.receive(desired("3"));
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    releaseRemoval.resolve();
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "2", state: "applied", appliedValue: true });
  });

  it("cancels preparation when the project is removed and joins it before preparing again", async () => {
    const entered = deferred(), release = deferred(), cancelled = deferred();
    let calls = 0;
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare: async (_projectId, signal) => {
      calls += 1;
      if (calls === 1) {
        signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        entered.resolve();
        await release.promise;
      }
    }, remove: async () => {} });
    await manager.receive(desired());
    await entered.promise;
    await manager.receive(desired("2", "original", false));
    await cancelled.promise;
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await manager.receive(desired("3"));
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    release.resolve();
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(calls).toBe(2);
  });

  it("reports and retries stopping a retained project absent from the initial cloud target", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ remove: async () => { if (++attempts === 1) throw new Error("stop failed"); } });
    await manager.receive(desired("1", "original", false));
    await manager.ensureProjectRemoval(projectId);
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "error");
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "1", error: { phase: "stop" }, lastFailure: { phase: "stop" } });
    await manager.ensureProjectRemoval(projectId);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "1", lastFailure: { phase: "stop" } });
    expect(attempts).toBe(2);
  });

  it("reconfirms an unacknowledged cached removal after restart", async () => {
    const first = await fixture();
    await first.manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    await first.manager.receive(desired());
    await first.wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await first.manager.receive(desired("2", "original", false));
    await first.wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await first.manager.stop();
    const stop = vi.fn(async () => {});
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "original", false));
    await reopened.configureProjectAdapters({ remove: stop });
    await reopened.ensureProjectRemoval(projectId);
    await reopened.settle();
    expect(stop).toHaveBeenCalledOnce();
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ targetRevision: "2", state: "applied" });
  });

  it("keeps an in-flight removal across repeated selection changes", async () => {
    const removing = deferred(), releaseRemoval = deferred();
    const prepare = vi.fn(async () => {});
    let removalSignal: AbortSignal | undefined;
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare, remove: async (_projectId, signal) => { removalSignal = signal; removing.resolve(); await releaseRemoval.promise; } });
    await manager.receive(desired("1"));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await manager.receive(desired("2", "original", false));
    await removing.promise;
    await manager.receive(desired("3"));
    await manager.receive(desired("4", "original", false));
    await manager.receive(desired("5"));
    try {
      expect(removalSignal?.aborted).toBe(false);
      expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "2", state: "applying" });
      expect(manager.current().effective.projects[0]?.ready).toBe(false);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally { releaseRemoval.resolve(); }
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "2", state: "applied" });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("retains completed removal until its matching result has been acknowledged", async () => {
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    await manager.receive(desired());
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    const earlier = manager.report();
    await manager.receive(desired("2", "original", false));
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await manager.acknowledge(earlier, { desired: desired("2", "original", false), observationRevision: "1", observationAccepted: true });
    expect(item(manager.current(), "projectRemoval")).toBeDefined();
    const completed = manager.report();
    await manager.acknowledge(completed, { desired: desired("2", "original", false), observationRevision: "2", observationAccepted: true });
    expect(manager.current().items.every(item => !("projectId" in item.key))).toBe(true);
  });

  it("rejects an unrelated accepted receipt without erasing unreported failure information", async () => {
    const { manager, wait } = await fixture({ applyNative: async () => { throw new TypeError("invalid"); } });
    await manager.receive(desired("1", "bad", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const report = manager.report();
    await expect(manager.acknowledge(report, { desired: desired("1", "bad", false), observationRevision: "8", observationAccepted: true })).rejects.toThrow("does not acknowledge");
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    expect(manager.current().observationRevision).toBe("0");
  });

  it("loads applied values without granting authority, then checks the cloud and repository again", async () => {
    const first = await fixture();
    await first.manager.configureProjectAdapters({ prepare: async () => {} });
    await first.manager.receive(desired());
    await first.wait(snapshot => snapshot.effective.projects[0]?.ready === true && snapshot.effective.native !== null);
    await first.manager.stop();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(reopened.current().synchronized).toBe(false);
    expect(reopened.current().effective.native).toBeNull();
    expect(reopened.report().observation).toBeNull();
    await reopened.receive(desired(), "9");
    expect(reopened.current().effective.projects[0]?.ready).toBe(false);
    expect(reopened.report().observation?.baseRevision).toBe("9");
  });

  it("rejects corrupted or foreign caches instead of inventing defaults", async () => {
    const { manager, file, wait } = await fixture();
    await manager.receive(desired("1", "good", false));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    await manager.stop();
    await expect(createWorkerConfigurationManager({ file, identity: { ...identity, workerId: projectId }, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow("identity");
    const cache = JSON.parse(await readFile(file, "utf8"));
    cache.items = [];
    await writeFile(file, JSON.stringify(cache));
    await expect(createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow("missing target");
  });

  it("does not consume a cached native tuple before preflight under the current local control mode", async () => {
    const first = await fixture();
    await first.manager.receive(desired("1", "previous-mode", false));
    await first.wait(snapshot => snapshot.effective.native?.model === "previous-mode");
    await first.manager.stop();
    const entered = deferred(), release = deferred(), observedFailure = deferred();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async () => { entered.resolve(); await release.promise; },
      onChange: snapshot => { if (item(snapshot, "native")?.state === "error") observedFailure.resolve(); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("1", "previous-mode", false));
    expect(reopened.current().effective.native).toBeNull();
    await entered.promise;
    expect(reopened.current().effective.native).toBeNull();
    release.reject(new TypeError("Arguments are invalid in the current control mode."));
    await observedFailure.promise;
    expect(reopened.current().effective.native).toBeNull();
    expect(item(reopened.current(), "native")?.appliedValue).toMatchObject({ model: "previous-mode" });
    await reopened.receive(desired("2", "previous-mode", false));
    await reopened.settle();
    expect(item(reopened.current(), "native")?.state).toBe("error");
    expect(reopened.current().effective.native).toBeNull();
  });

  it.each([
    { scope: "global", projects: false, model: "current-model", args: ["--no-alt-screen"] },
    { scope: "project", projects: true, model: "current-model", args: ["--no-alt-screen"] },
    { scope: "global", projects: false, model: null, args: [] },
    { scope: "project", projects: true, model: null, args: [] },
  ])("validates the current $scope target before exposing cached settings with model $model", async ({ projects, model, args }) => {
    const previous = desired("1", "previous-good", projects);
    const first = await fixture();
    await first.manager.receive({ ...previous, value: { ...previous.value, native: { ...previous.value.native, args: ["--search"] } } });
    await first.manager.settle();
    await first.manager.stop();
    const release = deferred(), entered = deferred(), checked: WorkerCloudNative[] = [], published: WorkerConfigurationSnapshot[] = [];
    const current = desired("2", "current-model", projects), native = { ...current.value.native, model, args };
    const effective = (snapshot: WorkerConfigurationSnapshot): WorkerCloudNative | null => projects ? snapshot.effective.projects[0]?.native ?? null : snapshot.effective.native;
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async value => {
        checked.push(value);
        if (value.model === model) {
          if (checked.filter(value => value.model === model).length === (projects ? 2 : 1)) entered.resolve();
          await release.promise;
        }
      },
      onChange: snapshot => { published.push(snapshot); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive({ ...current, value: { ...current.value, native } });
    try {
      await entered.promise;
      expect(effective(reopened.current())).toBeNull();
      expect(published.every(snapshot => effective(snapshot) === null)).toBe(true);
    } finally { release.resolve(); }
    await reopened.settle();
    expect(effective(reopened.current())).toEqual(native);
    expect(checked).toEqual(Array.from({ length: projects ? 2 : 1 }, () => native));
    expect(published.every(snapshot => effective(snapshot)?.model !== "previous-good")).toBe(true);
  });

  it("revalidates a historical successful tuple when the newest cloud native target fails", async () => {
    const first = await fixture();
    await first.manager.receive(desired("1", "previous-good", false));
    await first.wait(snapshot => snapshot.effective.native?.model === "previous-good");
    await first.manager.stop();
    const checked: string[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async native => { checked.push(native.model!); if (native.model === "new-invalid") throw new TypeError("invalid current target"); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "new-invalid", false));
    await reopened.settle();
    expect(checked).toEqual(["new-invalid", "previous-good"]);
    expect(reopened.current().effective.native?.model).toBe("previous-good");
    expect(item(reopened.current(), "native")).toMatchObject({ state: "error", targetRevision: "2", appliedValue: { model: "previous-good" } });
  });

  it("keeps an already validated live tuple available while applying the current target", async () => {
    const entered = deferred(), release = deferred();
    const { manager } = await fixture({ applyNative: async native => {
      if (native.model === "current-model") { entered.resolve(); await release.promise; }
    } });
    await manager.receive(desired("1", "previous-good"));
    await manager.settle();
    await manager.receive(desired("2", "current-model"));
    try {
      await entered.promise;
      expect(manager.current().effective.native?.model).toBe("previous-good");
      expect(manager.current().effective.projects[0]?.native?.model).toBe("previous-good");
    } finally { release.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.model).toBe("current-model");
    expect(manager.current().effective.projects[0]?.native?.model).toBe("current-model");
  });

  it.each([true, false])("retains the current failure when cached null-model history is usable: %s", async usable => {
    const first = await fixture(), original = desired("1");
    const previous = { ...original.value.native, model: null, args: ["--search"] };
    await first.manager.receive({ ...original, value: { ...original.value, native: previous } });
    await first.manager.settle();
    await first.manager.stop();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async native => {
        if (native.model === "new-invalid") throw new TypeError("invalid current target");
        if (!usable) throw new Error("historical provider unavailable");
      },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "new-invalid"));
    await reopened.settle();
    expect(reopened.current().effective.native).toEqual(usable ? previous : null);
    expect(reopened.current().effective.projects[0]?.native).toEqual(usable ? previous : null);
    for (const kind of ["native", "projectNative"] as const) {
      expect(item(reopened.current(), kind)).toMatchObject({ state: "error", appliedValue: previous, error: { code: "invalid_configuration" }, lastFailure: { code: "invalid_configuration" } });
    }
  });

  it.each(["superseded", "cancelled"] as const)("does not publish a %s historical validation", async transition => {
    const first = await fixture();
    await first.manager.receive(desired("1", "previous-good", false));
    await first.manager.settle();
    await first.manager.stop();
    const entered = deferred(), release = deferred(), cancellation = new AbortController(), published: WorkerConfigurationSnapshot[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: cancellation.signal,
      applyNative: async native => {
        if (native.model === "new-invalid") throw new TypeError("invalid current target");
        if (native.model === "previous-good") { entered.resolve(); await release.promise; }
      },
      onChange: snapshot => { published.push(snapshot); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "new-invalid", false));
    try {
      await entered.promise;
      if (transition === "superseded") await reopened.receive(desired("3", "latest", false));
      else cancellation.abort(new Error("Worker stopped during historical validation."));
    } finally { release.resolve(); }
    await reopened.settle();
    expect(reopened.current().effective.native?.model ?? null).toBe(transition === "superseded" ? "latest" : null);
    expect(published.every(snapshot => snapshot.effective.native?.model !== "previous-good")).toBe(true);
  });

  it("settles immediate application work without waiting for a future retry", async () => {
    const { manager } = await fixture({ applyNative: async () => { throw new TypeError("invalid"); } });
    await manager.receive(desired("1", "invalid", false));
    await manager.settle();
    expect(manager.current().effective).toMatchObject({ maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: null });
    expect(item(manager.current(), "native")?.state).toBe("error");
    expect(Date.parse(item(manager.current(), "native")!.nextAttemptAt!)).toBeGreaterThan(Date.now());
  });

  it("propagates persistence failure and never publishes an uncommitted success", async () => {
    const storageError = new Error("disk write rejected"), errors: unknown[] = [], nativeEvents: string[] = [];
    let rejectWrites = false;
    const { manager, wait } = await fixture({ onError: error => { errors.push(error); }, onNativeApplication: event => { if (event.key.kind === "native") nativeEvents.push(event.kind); }, applyNative: async () => { rejectWrites = true; }, persist: async (file, contents) => {
      const cache = JSON.parse(contents);
      if (rejectWrites && cache.items.some((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native" && entry.value.state === "applied")) throw storageError;
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.receive(desired("1", "good", false));
    await wait(snapshot => snapshot.effective.maxConcurrent === 2);
    await vi.waitFor(() => expect(errors).toEqual([storageError]));
    expect(nativeEvents).toEqual(["started", "cancelled"]);
    expect(manager.current().effective.native).toBeNull();
    expect(() => manager.report()).toThrow(storageError);
    await expect(manager.stop()).rejects.toBe(storageError);
    fixtures.find(fixture => fixture.manager === manager)!.expectedStopError = storageError;
  });

  it("keeps native application independent of an observer failure", async () => {
    const { manager } = await fixture({ onNativeApplication: () => { throw new Error("observer failed"); } });
    await manager.receive(desired("1", "good", false));
    await manager.settle();
    expect(item(manager.current(), "native")).toMatchObject({ state: "applied", appliedValue: { agent: "codex", model: "good" } });
  });
});
