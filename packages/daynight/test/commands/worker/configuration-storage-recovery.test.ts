import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerCloudDesired, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudReport } from "../../../src/api/worker-configuration.js";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationManagerOptions, WorkerConfigurationSnapshot } from "../../../src/commands/worker/configuration.js";
import { readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import type { ConfigurationPersistenceEvent } from "../../../src/commands/worker/configuration-persistence.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";

const uuidSequence = vi.hoisted(() => ({ next: 10_000 }));
vi.mock("node:crypto", async original => ({
  ...await original<object>(), randomUUID: () => `00000000-0000-4000-8000-${String(uuidSequence.next++).padStart(12, "0")}`,
}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
const root = fileURLToPath(new URL("../../../../../.tmp/configuration-storage-recovery/", import.meta.url));
const desired = (revision = "1", model = "original"): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-12T00:00:00Z", value: {
  maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 3, preferPlatformSpecificTasks: false,
  native: { agent: "codex", model, args: [] }, projects: [],
} });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};
const ioFailure = () => Object.assign(new Error("Checkpoint device is temporarily unavailable"), { code: "EIO", syscall: "write" });
const keyMatches = (first: WorkerCloudItemKey, second: WorkerCloudItemKey): boolean => first.kind === second.kind && (!("projectId" in first) || "projectId" in second && first.projectId === second.projectId);
const record = (cache: WorkerConfigurationCache, key: WorkerCloudItemKey): TrackedConfigurationItem | undefined => cache.currentItems.find(item => keyMatches(item.value.key, key));
const item = (snapshot: WorkerConfigurationSnapshot, key: WorkerCloudItemKey) => snapshot.items.find(value => keyMatches(value.key, key));
type Attempt = { readonly cache: WorkerConfigurationCache; readonly bytes: string; readonly iterator: Iterable<string> };
type Fixture = { directory: string; manager: WorkerConfigurationManager; releases: (() => void)[]; expectedStopError?: unknown };
const fixtures: Fixture[] = [], operations: Operation[] = [];
const operation = (options?: Parameters<typeof createOperation>[0]): Operation => { const current = createOperation(options); operations.push(current); return current; };
const clock = () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(new Date("2026-11-12T00:00:00Z")); };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

const fixture = async (options: {
  applyNative?: WorkerConfigurationManagerOptions["applyNative"];
  beforePersist?: (attempt: Attempt) => Promise<void>;
  onChange?: (snapshot: WorkerConfigurationSnapshot) => void;
} = {}) => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json");
  const attempts: Attempt[] = [], written: Attempt[] = [], snapshots: WorkerConfigurationSnapshot[] = [], states: ConfigurationPersistenceEvent[] = [], errors: unknown[] = [];
  const blocked = deferred<ConfigurationPersistenceEvent>();
  const applyNative = options.applyNative ?? vi.fn(async (_native: WorkerCloudNative) => {});
  const manager = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative,
    onChange: snapshot => { snapshots.push(snapshot); options.onChange?.(snapshot); }, onError: error => { errors.push(error); },
    onStorageState: event => { states.push(event); if (event.kind === "blocked") blocked.resolve(event); },
    persist: async (target, chunks) => {
      const iterator = chunks(), bytes = [...iterator].join(""), attempt = { cache: JSON.parse(bytes) as WorkerConfigurationCache, bytes, iterator };
      attempts.push(attempt);
      await options.beforePersist?.(attempt);
      await replaceFileAtomicallyFromChunks(target, chunks(), 0o600);
      written.push(attempt);
    },
  });
  const entry: Fixture = { directory, manager, releases: [] }; fixtures.push(entry);
  const disk = async (): Promise<WorkerConfigurationCache> => (await readConfigurationCache(file, identity, new AbortController().signal)).cache;
  const raw = async (): Promise<WorkerConfigurationCache> => JSON.parse(await readFile(file, "utf8"));
  return { manager, file, entry, applyNative, attempts, written, snapshots, states, errors, blocked: blocked.promise, disk, raw };
};

afterEach(async () => {
  const active = fixtures.splice(0);
  for (const current of operations.splice(0)) current.dispose();
  for (const current of active) for (const release of current.releases) release();
  const closing = Promise.allSettled(active.map(current => current.manager.stop()));
  if (vi.isFakeTimers()) await advance(5_000);
  const outcomes = await closing;
  vi.useRealTimers();
  for (const { directory } of active) await rm(directory, { recursive: true, force: true });
  const failures = outcomes.flatMap((outcome, index) => outcome.status === "rejected" && outcome.reason !== active[index]!.expectedStopError ? [outcome.reason] : []);
  if (failures.length !== 0) throw new AggregateError(failures, "Configuration recovery fixture shutdown failed.");
});

describe("Worker configuration manager storage recovery", () => {
  it("retains one observed apply result until the same frozen checkpoint is durable", async () => {
    clock();
    const failure = ioFailure(); let failed = false;
    const f = await fixture({ beforePersist: async ({ cache }) => { if (!failed && record(cache, { kind: "native" })?.value.state === "applied") { failed = true; throw failure; } } });
    await f.manager.receive(desired());
    const blocked = await f.blocked, native = record(await f.raw(), { kind: "native" })!;
    expect(blocked).toMatchObject({ kind: "blocked", phase: "persist", error: failure, recordIds: expect.arrayContaining([native.recordId]) });
    expect(f.manager.isReady()).toBe(false); expect(f.applyNative).toHaveBeenCalledOnce();
    expect(native.value).toMatchObject({ state: "applying", appliedValue: null });
    expect(item(f.manager.current(), { kind: "native" })).toMatchObject({ state: "applying", appliedValue: null });
    expect(f.manager.current().effective.native).toBeNull();
    expect(f.snapshots.every(snapshot => item(snapshot, { kind: "native" })?.state !== "applied")).toBe(true);
    await advance(5_000); await f.manager.settle();
    const resultAttempts = f.attempts.filter(({ cache }) => record(cache, { kind: "native" })?.value.state === "applied");
    expect(resultAttempts).toHaveLength(2); expect(resultAttempts[0]!.bytes).toBe(resultAttempts[1]!.bytes);
    expect(resultAttempts[0]!.iterator).not.toBe(resultAttempts[1]!.iterator);
    expect(f.written.filter(attempt => attempt.bytes === resultAttempts[0]!.bytes)).toHaveLength(1);
    expect(f.applyNative).toHaveBeenCalledOnce(); expect(f.manager.isReady()).toBe(true);
    expect(record(await f.disk(), { kind: "native" })).toMatchObject({ recordId: native.recordId, value: { state: "applied", appliedValue: desired().value.native }, actualSource: { recordId: native.recordId } });
    expect(f.manager.current().effective.native).toEqual(desired().value.native);
    expect(f.states.map(event => event.kind)).toEqual(["blocked", "recovered"]); expect(f.errors).toEqual([]);
  });

  it("keeps the original persisted stop ownership and never repeats its observed side effect", async () => {
    clock();
    const projectId = id(10), key = { kind: "projectRemoval" as const, projectId }, failure = ioFailure(); let armed = false, failed = false;
    const f = await fixture({ beforePersist: async ({ cache }) => { if (armed && !failed && record(cache, key)?.value.state === "applied") { failed = true; throw failure; } } });
    await f.manager.receive(desired()); await f.manager.settle();
    const remove = vi.fn(async (_projectId: string, _signal: AbortSignal) => {});
    await f.manager.configureProjectAdapters({ remove }); armed = true;
    await f.manager.ensureProjectRemoval(projectId); await f.blocked;
    const original = record(await f.raw(), key)!;
    expect(original).toMatchObject({ started: true, value: { state: "applying", appliedValue: null } });
    expect(f.manager.isReady()).toBe(false); expect(item(f.manager.current(), key)?.state).toBe("applying");
    expect(remove).toHaveBeenCalledExactlyOnceWith(projectId, expect.any(AbortSignal));
    await advance(5_000); await f.manager.settle();
    const resultAttempts = f.attempts.filter(({ cache }) => record(cache, key)?.value.state === "applied");
    expect(resultAttempts).toHaveLength(2); expect(resultAttempts[0]!.bytes).toBe(resultAttempts[1]!.bytes);
    expect(resultAttempts[0]!.iterator).not.toBe(resultAttempts[1]!.iterator);
    expect(f.written.filter(attempt => attempt.bytes === resultAttempts[0]!.bytes)).toHaveLength(1);
    expect(remove).toHaveBeenCalledOnce();
    expect(record(await f.disk(), key)).toMatchObject({ recordId: original.recordId, started: false, value: { state: "applied", appliedValue: true }, actualSource: { recordId: original.recordId } });
    expect(f.manager.isReady()).toBe(true); expect(f.errors).toEqual([]);
  });

  it("owns a confirmed POST acknowledgement beyond its 15 second waiter and commits only its captured facts", async () => {
    clock();
    const completedId = id(20), failedId = id(21), laterId = id(22), failure = ioFailure();
    let recover = false, ackBytes: string | undefined, nativeCalls = 0;
    const f = await fixture({ applyNative: vi.fn(async (_native, signal) => {
      if (++nativeCalls <= 2) throw new TypeError(`Invalid native arguments ${nativeCalls}`);
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    }), beforePersist: async attempt => {
      if (attempt.cache.authority.observationRevision !== "1") return;
      ackBytes ??= attempt.bytes;
      if (attempt.bytes === ackBytes && !recover) throw failure;
    } });
    let failedStops = 0;
    const remove = vi.fn(async (projectId: string) => { if (projectId === failedId && ++failedStops === 1) throw new Error("Stop temporarily unavailable"); });
    await f.manager.configureProjectAdapters({ remove });
    const target = desired(); await f.manager.receive(target); await f.manager.settle();
    await f.manager.ensureProjectRemoval(completedId); await f.manager.ensureProjectRemoval(failedId); await f.manager.settle();
    const before = await f.disk(), capturedNative = record(before, { kind: "native" })!, capturedStop = record(before, { kind: "projectRemoval", projectId: failedId })!;
    const capturedCompleted = record(before, { kind: "projectRemoval", projectId: completedId })!;
    const sent = f.manager.report(), capturedContext = f.manager.reportContext(sent)!, cursor = record(before, sent.observation!.items.at(-1)!.key)!.recordId;
    expect(sent.observation!.items[0]!.key).toEqual({ kind: "projectRemoval", projectId: failedId });
    expect(sent.observation!.items.find(item => item.key.kind === "native")?.lastFailure).toEqual(capturedNative.value.lastFailure);
    expect(sent.observation!.items.find(item => item.key.kind === "projectRemoval" && item.key.projectId === failedId)?.lastFailure).toEqual(capturedStop.value.lastFailure);
    await advance(5_000); await f.manager.settle();
    await f.manager.ensureProjectRemoval(laterId); await f.manager.settle();
    const changed = await f.disk(), newerNative = record(changed, { kind: "native" })!;
    expect(record(changed, { kind: "projectRemoval", projectId: laterId })!.recordId > cursor).toBe(true);
    expect(newerNative.recordId).toBe(capturedNative.recordId); expect(newerNative.failureId).not.toBe(capturedNative.failureId);
    expect(record(changed, { kind: "projectRemoval", projectId: failedId })).toMatchObject({ failureId: capturedStop.failureId, value: { state: "applied" } });
    const receipt = { desired: target, observationRevision: "1", observationAccepted: true };
    const post = vi.fn(async (_sent: WorkerCloudReport, current: Operation) => { current.check(); return receipt; });
    const op = operation({ limits: { totalMs: 15_000 } });
    const remoteResult = await post(sent, op);
    const accepting = f.manager.acknowledge(sent, remoteResult, op.signal).catch(error => error);
    const blocked = await f.blocked;
    expect(blocked.context).toMatchObject({ kind: "receipt-accept", source: { state: "initialized", desiredRevision: "1", observationRevision: "0" }, report: capturedContext });
    expect(Object.isFrozen(blocked.context)).toBe(true);
    expect(f.manager.isReady()).toBe(false); expect((await f.disk()).authority.observationRevision).toBe("0");
    expect(record(await f.disk(), { kind: "projectRemoval", projectId: completedId })?.recordId).toBe(capturedCompleted.recordId);
    await advance(15_000);
    expect(await accepting).toMatchObject({ name: "OperationError", kind: "deadline" });
    expect(post).toHaveBeenCalledOnce(); expect(remoteResult).toBe(receipt); expect(remoteResult.observationAccepted).toBe(true);
    expect(f.manager.isReady()).toBe(false); expect(f.written.some(attempt => attempt.bytes === ackBytes)).toBe(false);
    recover = true;
    const ready = f.manager.waitReady(new AbortController().signal);
    await advance(20_000); await ready;
    const committed = await f.disk();
    expect(committed.authority.observationRevision).toBe("1"); expect(committed.projectionCursor).toBe(cursor);
    expect(record(committed, { kind: "native" })).toMatchObject({ recordId: newerNative.recordId, failureId: newerNative.failureId, value: { lastFailure: newerNative.value.lastFailure } });
    expect(record(committed, { kind: "projectRemoval", projectId: failedId })).toMatchObject({ recordId: capturedStop.recordId, failureId: null, value: { state: "applied", lastFailure: null } });
    expect(record(committed, { kind: "projectRemoval", projectId: completedId })).toBeUndefined();
    expect(record(committed, { kind: "projectRemoval", projectId: laterId })).toMatchObject({ value: { state: "applied", appliedValue: true } });
    const ackAttempts = f.attempts.filter(attempt => attempt.bytes === ackBytes);
    expect(ackAttempts).toHaveLength(4); expect(new Set(ackAttempts.map(attempt => attempt.iterator)).size).toBe(4);
    expect(f.written.filter(attempt => attempt.bytes === ackBytes)).toHaveLength(1);
    const receiptEvents = f.states.filter(event => event.context?.kind === "receipt-accept");
    expect(receiptEvents.at(-1)).toMatchObject({ kind: "recovered", context: blocked.context });
    expect(receiptEvents.every(event => event.context === blocked.context)).toBe(true);
    expect(post).toHaveBeenCalledOnce(); expect(remoteResult).toEqual(receipt); expect(f.errors).toEqual([]);
  });

  it("removes a canceled receive waiter and installs only the latest waiting target after recovery", async () => {
    clock();
    let failed = false;
    const f = await fixture({ beforePersist: async ({ cache }) => { if (!failed && record(cache, { kind: "native" })?.value.state === "applied") { failed = true; throw ioFailure(); } } });
    await f.manager.receive(desired()); await f.blocked;
    const cancellation = new AbortController(), reason = new Error("Old exchange cancelled"), op = operation({ signal: cancellation.signal, limits: { totalMs: 15_000 } });
    const obsolete = f.manager.receive(desired("2", "obsolete"), "0", op.signal).catch(error => error);
    const canceledReady = f.manager.waitReady(op.signal).catch(error => error);
    const latest = f.manager.receive(desired("3", "latest"));
    const ready = f.manager.waitReady();
    cancellation.abort(reason);
    expect(await obsolete).toMatchObject({ name: "OperationError", kind: "cancelled", cause: reason });
    expect(await canceledReady).toMatchObject({ name: "OperationError", kind: "cancelled", cause: reason });
    expect(f.attempts.some(({ cache }) => cache.authority.desired?.revision === "2")).toBe(false);
    await advance(5_000); await Promise.all([latest, ready]); await f.manager.settle();
    expect(f.manager.current().desired?.revision).toBe("3"); expect(f.manager.current().effective.native?.model).toBe("latest");
    expect(f.snapshots.some(snapshot => snapshot.desired?.revision === "2")).toBe(false);
    expect(f.attempts.some(({ cache }) => cache.authority.desired?.revision === "2")).toBe(false);
    expect((await f.disk()).authority.desired?.revision).toBe("3");
    expect(vi.mocked(f.applyNative).mock.calls.map(([native]) => native.model)).toEqual(["original", "latest"]);
  });

  it("joins an active observed-result write after beginDrain exceeds its five second retry window", async () => {
    clock();
    const entered = deferred(), release = deferred(); let stopped = false;
    const f = await fixture({ beforePersist: async ({ cache }) => { if (record(cache, { kind: "native" })?.value.state === "applied") { entered.resolve(); await release.promise; } } });
    f.entry.releases.push(() => release.resolve());
    await f.manager.receive(desired()); await entered.promise;
    f.manager.beginDrain(); const stopping = f.manager.stop().then(() => { stopped = true; });
    await advance(6_000);
    expect(stopped).toBe(false); expect(f.manager.isReady()).toBe(false); expect(f.applyNative).toHaveBeenCalledOnce();
    expect(item(f.manager.current(), { kind: "native" })).toMatchObject({ state: "applying", appliedValue: null });
    expect(record(await f.raw(), { kind: "native" })).toMatchObject({ value: { state: "applying", appliedValue: null } });
    release.resolve(); await stopping;
    const committed = record(await f.disk(), { kind: "native" })!;
    expect(stopped).toBe(true); expect(f.applyNative).toHaveBeenCalledOnce();
    expect(committed).toMatchObject({ value: { state: "applied", appliedValue: desired().value.native }, actualSource: { recordId: committed.recordId } });
    expect(item(f.manager.current(), { kind: "native" })).toMatchObject({ state: "applied", appliedValue: desired().value.native });
    expect(f.states).toEqual([]); expect(f.errors).toEqual([]);
  });

  it.each(["format", "publication"] as const)("exposes a fatal %s failure without storage retries", async kind => {
    clock();
    const failure = new TypeError(`Invalid ${kind}`);
    const f = await fixture({ beforePersist: async ({ cache }) => { if (kind === "format" && record(cache, { kind: "native" })?.value.state === "applied") throw failure; },
      onChange: snapshot => { if (kind === "publication" && item(snapshot, { kind: "native" })?.state === "applied") throw failure; } });
    await f.manager.receive(desired());
    const settling = f.manager.settle().catch(error => error);
    expect(await settling).toBe(failure); f.entry.expectedStopError = failure;
    expect(f.manager.isReady()).toBe(false); expect(f.errors).toEqual([failure]); expect(f.states).toEqual([]);
    const resultAttempts = () => f.attempts.filter(({ cache }) => record(cache, { kind: "native" })?.value.state === "applied");
    expect(resultAttempts()).toHaveLength(1); await advance(60_000); expect(resultAttempts()).toHaveLength(1);
    expect(record(await f.raw(), { kind: "native" })?.value.state).toBe(kind === "publication" ? "applied" : "applying");
    await expect(f.manager.stop()).rejects.toBe(failure);
  });
});
