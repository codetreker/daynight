import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerConfigurationPersistence, UnsavedConfigurationError, waitForConfigurationOperation } from "../../../src/commands/worker/configuration-persistence.js";
import type { ConfigurationPersistenceEvent, WorkerConfigurationPersistence } from "../../../src/commands/worker/configuration-persistence.js";
import { createConfigurationCache, readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open) };
});
const actualFilesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const root = fileURLToPath(new URL("../../../../../.tmp/persistence/", import.meta.url));
const fixtures: { directory: string; store?: WorkerConfigurationPersistence }[] = [];
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};
const ioFailure = () => Object.assign(new Error("No space left on device"), { code: "ENOSPC", syscall: "write" });
const realPersist = (file: string, chunks: () => Iterable<string>): Promise<void> => replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
const fixture = async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json");
  const entry: { directory: string; store?: WorkerConfigurationPersistence } = { directory };
  fixtures.push(entry);
  return { file, directory, entry };
};
const observe = () => {
  const events: ConfigurationPersistenceEvent[] = [];
  let next = deferred<ConfigurationPersistenceEvent>();
  return {
    events,
    onState: (event: ConfigurationPersistenceEvent) => { events.push(event); next.resolve(event); next = deferred<ConfigurationPersistenceEvent>(); },
    next: () => next.promise,
  };
};
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
const clock = () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(new Date("2026-11-12T00:00:00Z")); };

afterEach(async () => {
  const active = fixtures.splice(0);
  const closing = Promise.allSettled(active.flatMap(({ store }) => store === undefined ? [] : [store.finish()]));
  if (vi.isFakeTimers()) await advance(5_000);
  const outcomes = await closing;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const { directory } of active) await rm(directory, { recursive: true, force: true });
  const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
  if (errors.length !== 0) throw new AggregateError(errors, "Persistence fixture shutdown failed.");
});

describe("Worker configuration persistence", () => {
  it("retries a frozen FIFO checkpoint with fresh identical chunks and publishes only after durable replacement", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe(), release = deferred(), writing = deferred();
    const bytes: string[] = [], iterators: Iterable<string>[] = [], order: number[] = [];
    let prepares = 0, active = 0, maximum = 0, calls = 0;
    const failure = ioFailure();
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState, persist: async (target, chunks) => {
      active++; maximum = Math.max(maximum, active);
      try {
        const iterator = chunks(); iterators.push(iterator); bytes.push([...iterator].join(""));
        if (++calls === 1) throw failure;
        if (calls === 2) { writing.resolve(); await release.promise; }
        await realPersist(target, chunks);
      } finally { active--; }
    } });
    const original = store.current();
    const first = store.commit(current => { prepares++; return { cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["first"], publish: cache => { expect(cache.nextFailureId).toBe(2); order.push(1); } }; });
    const second = store.commit(current => { prepares++; expect(current.nextFailureId).toBe(2); return { cache: { ...current, nextFailureId: 3 }, write: true, recordIds: ["second"], publish: () => { order.push(2); } }; });
    const proofOnly = store.commit(current => { prepares++; expect(current.nextFailureId).toBe(3); return { cache: current, write: false, recordIds: [], publish: () => { order.push(3); } }; });
    await state.next();
    expect(store.isReady()).toBe(false); expect(store.current()).toBe(original); expect(prepares).toBe(1); expect(order).toEqual([]);
    const ready = store.waitReady(new AbortController().signal);
    await advance(5_000); await writing.promise;
    expect(order).toEqual([]); expect(prepares).toBe(1);
    release.resolve(); await Promise.all([first, second, proofOnly, ready]);
    expect(bytes[0]).toBe(bytes[1]); expect(iterators[0]).not.toBe(iterators[1]);
    expect(order).toEqual([1, 2, 3]); expect(prepares).toBe(3); expect(calls).toBe(3); expect(maximum).toBe(1); expect(store.isReady()).toBe(true);
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.nextFailureId).toBe(3);
    expect(state.events.map(event => event.kind)).toEqual(["blocked", "recovered"]);
  });

  it("uses the exact capped 5/10/20/40/60 second retry sequence", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe(), started = Date.now();
    const attempts: number[] = [];
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState, persist: async (target, chunks) => {
      attempts.push(Date.now() - started);
      if (attempts.length <= 6) throw ioFailure();
      await realPersist(target, chunks);
    } });
    const committing = store.commit(current => ({ cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["retry"], publish: () => {} }));
    await state.next();
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) await advance(delay);
    await committing;
    expect(attempts).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    expect(state.events.filter(event => event.kind === "blocked").map(event => Date.parse(event.nextAttemptAt!) - started)).toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
  });

  it("cancels readiness and result waiters without cancelling the owned result", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe();
    let calls = 0, published = 0;
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState, persist: async (target, chunks) => { if (++calls === 1) throw ioFailure(); await realPersist(target, chunks); } });
    const owned = store.commit(current => ({ cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["confirmed-receipt"], publish: () => { published++; } }));
    await state.next();
    const readiness = new AbortController(), result = new AbortController(), reason = new Error("Operation deadline");
    const waiting = store.waitReady(readiness.signal), accepting = waitForConfigurationOperation(owned, result.signal);
    const readyRejected = expect(waiting).rejects.toBe(reason), resultRejected = expect(accepting).rejects.toBe(reason);
    readiness.abort(reason); result.abort(reason); await Promise.all([readyRejected, resultRejected]);
    expect(published).toBe(0); expect(calls).toBe(1);
    await advance(5_000); await owned;
    expect(published).toBe(1); expect(calls).toBe(2); expect(store.current().nextFailureId).toBe(2);
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.nextFailureId).toBe(2);
  });

  it("recovers a real initial read I/O failure without replacing an existing valid cache", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe(), original = createConfigurationCache(identity);
    await mkdir(file);
    const loading = createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState });
    const event = await state.next(); expect(event.phase).toBe("read"); expect(event.error).toMatchObject({ code: "EISDIR" });
    await rm(file, { recursive: true }); await writeFile(file, JSON.stringify(original));
    await advance(5_000); const store = entry.store = await loading;
    expect(store.current()).toEqual(original); expect(store.isReady()).toBe(true);
    expect(state.events.map(event => event.kind)).toEqual(["blocked", "recovered"]);
  });

  it("recovers a real directory creation failure after the missing-file read", async () => {
    clock();
    const { file: blocker, entry } = await fixture(), state = observe();
    const file = path.join(blocker, "child", "configuration.json");
    // Introduce the fault between read and mkdir, retaining the real failing filesystem operation.
    vi.mocked(filesystem.mkdir).mockImplementationOnce(async (...args) => { await writeFile(blocker, "blocked"); return actualFilesystem.mkdir(...args); });
    const loading = createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState });
    const event = await state.next(); expect(event.phase).toBe("directory"); expect(event.error).toMatchObject({ code: "ENOTDIR" });
    await rm(blocker); await advance(5_000);
    const store = entry.store = await loading;
    expect(store.isReady()).toBe(true);
    await store.commit(current => ({ cache: current, write: true, recordIds: [], publish: () => {} }));
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache).toEqual(store.current());
  });

  it("freezes migration identities across write retries and persists schema 5", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe(), encodings: string[] = [];
    await writeFile(file, JSON.stringify({ schemaVersion: 4, identity, desired: null, observationRevision: "0", nextFailureId: 1, items: [], nativeModes: {} }));
    const loading = createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState, persist: async (target, chunks) => { encodings.push([...chunks()].join("")); if (encodings.length === 1) throw ioFailure(); await realPersist(target, chunks); } });
    expect((await state.next()).phase).toBe("persist");
    await advance(5_000); const store = entry.store = await loading;
    expect(encodings).toHaveLength(2); expect(encodings[0]).toBe(encodings[1]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(store.current());
    expect(store.current().schemaVersion).toBe(5);
  });

  it.each(["corrupt", "foreign", "schema"])("rejects a %s cache without retry or empty replacement", async kind => {
    const { file } = await fixture(), state = observe();
    const cache = createConfigurationCache(identity);
    const bytes = kind === "corrupt" ? "{broken" : JSON.stringify(kind === "foreign" ? { ...cache, identity: { ...identity, workerId: "44444444-4444-4444-8444-444444444444" } } : { ...cache, schemaVersion: 99 });
    await writeFile(file, bytes);
    await expect(createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState })).rejects.toBeInstanceOf(Error);
    expect(state.events).toEqual([]); expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it.each(["encoder", "mixed", "prepare", "publish"])("retains fatal %s errors without treating them as storage retry", async kind => {
    const { file, entry } = await fixture(), state = observe(), primary = new TypeError("Bad format");
    const failure = kind === "mixed" ? new AggregateError([primary, ioFailure()], "Encoding and close failed", { cause: primary }) : primary;
    let writes = 0;
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState, persist: async (target, chunks) => { writes++; if (kind === "encoder" || kind === "mixed") throw failure; await realPersist(target, chunks); } });
    await expect(store.commit(current => {
      if (kind === "prepare") throw primary;
      return { cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["fatal"], publish: () => { if (kind === "publish") throw primary; } };
    })).rejects.toBe(failure);
    await expect(store.finish()).rejects.toBe(failure);
    delete entry.store;
    expect(state.events).toEqual([]); expect(writes).toBe(kind === "prepare" ? 0 : 1);
    if (kind === "publish") expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.nextFailureId).toBe(2);
  });

  it("retains a real chunk encoder failure and leaves the preceding checkpoint intact", async () => {
    const { file, entry } = await fixture(), state = observe();
    const original = createConfigurationCache(identity);
    await writeFile(file, JSON.stringify(original));
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState });
    const invalid = { ...original, nextFailureId: 2n } as unknown as WorkerConfigurationCache;
    let caught: unknown;
    try { await store.commit(() => ({ cache: invalid, write: true, recordIds: ["encoder"], publish: () => { throw new Error("Invalid encoding published"); } })); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TypeError);
    expect(state.events).toEqual([]); expect(store.current()).toEqual(original);
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache).toEqual(original);
    await expect(store.finish()).rejects.toBe(caught);
    delete entry.store;
  });

  it("keeps persisted outcomes successful when notification fails and exposes the independent error at finish", async () => {
    clock();
    const { file, entry } = await fixture(), failed = deferred(), notification = new Error("Diagnostic output failed");
    let calls = 0;
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: event => { if (event.kind === "blocked") failed.resolve(); else throw notification; }, persist: async (target, chunks) => { if (++calls === 1) throw ioFailure(); await realPersist(target, chunks); } });
    const owned = store.commit(current => ({ cache: { ...current, nextFailureId: 2 }, write: true, recordIds: [], publish: () => {} }));
    await failed.promise; await advance(5_000); await owned;
    expect(store.current().nextFailureId).toBe(2); await expect(store.finish()).rejects.toBe(notification); delete entry.store;
  });

  it("stops scheduling after the drain window, reports unsaved record IDs, and preserves the real cause", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe(), rootSignal = new AbortController(), failure = ioFailure();
    let writes = 0;
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: rootSignal.signal, onState: state.onState, persist: async () => { writes++; throw failure; } });
    const owned = store.commit(current => ({ cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["result-identity"], publish: () => { throw new Error("Unsaved result published"); } }));
    const rejected = expect(owned).rejects.toMatchObject({ name: "UnsavedConfigurationError", recordIds: ["result-identity"], cause: failure });
    await state.next(); rootSignal.abort(new Error("Shutdown"));
    const finished = expect(store.finish()).rejects.toBeInstanceOf(UnsavedConfigurationError);
    await advance(5_000); await Promise.all([rejected, finished]);
    delete entry.store;
    expect(writes).toBe(1); expect(store.current().nextFailureId).toBe(1);
    await advance(120_000); expect(writes).toBe(1);
  });

  it("keeps storage blocked when a proof-only commit follows an unsaved checkpoint during drain", async () => {
    clock();
    const { file, entry } = await fixture(), state = observe(), failure = ioFailure();
    let writes = 0, proofPublications = 0;
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState, persist: async () => { writes++; throw failure; } });
    const original = store.current();
    const owned = store.commit(current => ({ cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["unsaved-first"], publish: () => { throw new Error("Unsaved result published"); } }));
    const outcome = owned.catch(error => error);
    await state.next(); store.beginDrain();
    const proofOnly = store.commit(current => ({ cache: current, write: false, recordIds: [], publish: committed => { expect(committed).toBe(original); proofPublications++; } }));
    const later = store.commit(current => ({ cache: { ...current, nextFailureId: 3 }, write: true, recordIds: ["unsaved-later"], publish: () => { throw new Error("Unsaved result published"); } }));
    const laterOutcome = later.catch(error => error);
    const finishing = store.finish().catch(error => error);
    await advance(5_000); await proofOnly;
    const finishError = await finishing; delete entry.store;
    expect(state.events.map(event => event.kind)).toEqual(["blocked"]);
    expect(await outcome).toMatchObject({ name: "UnsavedConfigurationError", recordIds: ["unsaved-first"], cause: failure });
    expect(await laterOutcome).toMatchObject({ name: "UnsavedConfigurationError", recordIds: ["unsaved-later"], cause: failure });
    expect(finishError).toBeInstanceOf(AggregateError);
    expect(finishError.errors.map((error: UnsavedConfigurationError) => error.recordIds)).toEqual([["unsaved-first"], ["unsaved-later"]]);
    expect(proofPublications).toBe(1); expect(writes).toBe(1); expect(store.current()).toBe(original);
    expect(store.isReady()).toBe(false);
  });

  it("allows finite result commits during drain and joins late active writes beyond its five second window", async () => {
    clock();
    const { file, entry } = await fixture(), entered = deferred(), release = deferred();
    let finished = false, published = 0;
    const store = entry.store = await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, persist: async (target, chunks) => { entered.resolve(); await release.promise; await realPersist(target, chunks); } });
    store.beginDrain(); expect(store.isReady()).toBe(false);
    const owned = store.commit(current => ({ cache: { ...current, nextFailureId: 2 }, write: true, recordIds: ["late-result"], publish: () => { published++; } }));
    await entered.promise;
    const finishing = store.finish().then(() => { finished = true; });
    await advance(6_000); expect(finished).toBe(false); expect(published).toBe(0);
    release.resolve(); await Promise.all([owned, finishing]);
    expect(finished).toBe(true); expect(published).toBe(1);
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.nextFailureId).toBe(2);
  });

  it("starts root drain during initialization and settles after the active read and retry deadline", async () => {
    clock();
    const { file } = await fixture(), state = observe(), rootSignal = new AbortController();
    await mkdir(file);
    const loading = createWorkerConfigurationPersistence({ file, identity, signal: rootSignal.signal, onState: state.onState });
    const rejected = expect(loading).rejects.toMatchObject({ name: "UnsavedConfigurationError", recordIds: [], cause: { code: "EISDIR" } });
    await state.next(); rootSignal.abort(); await advance(5_000); await rejected;
    expect(state.events).toHaveLength(1);
  });

  it("joins the real reader close after root cancellation even beyond the drain deadline", async () => {
    clock();
    const { file } = await fixture(), entered = deferred(), release = deferred(), rootSignal = new AbortController();
    await writeFile(file, JSON.stringify(createConfigurationCache(identity)));
    vi.mocked(filesystem.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFilesystem.open(...args), close = handle.close.bind(handle);
      handle.close = async () => { entered.resolve(); await release.promise; await close(); };
      return handle;
    });
    let settled = false;
    const reason = new Error("Startup cancelled");
    const loading = createWorkerConfigurationPersistence({ file, identity, signal: rootSignal.signal }).finally(() => { settled = true; });
    const rejected = expect(loading).rejects.toMatchObject({ name: "UnsavedConfigurationError", cause: reason });
    await entered.promise; rootSignal.abort(reason); await advance(6_000);
    expect(settled).toBe(false); release.resolve(); await rejected;
  });

  it("preserves mixed malformed-read and real close failure chains without retry", async () => {
    const { file } = await fixture(), state = observe(), closeFailure = ioFailure();
    await writeFile(file, "{broken");
    vi.mocked(filesystem.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFilesystem.open(...args), close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw closeFailure; };
      return handle;
    });
    let caught: unknown;
    try { await createWorkerConfigurationPersistence({ file, identity, signal: new AbortController().signal, onState: state.onState }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBeInstanceOf(SyntaxError);
    expect((caught as AggregateError).errors[1]).toBe(closeFailure);
    expect((caught as AggregateError).cause).toBe((caught as AggregateError).errors[0]);
    expect(state.events).toEqual([]); expect(await readFile(file, "utf8")).toBe("{broken");
  });
});
