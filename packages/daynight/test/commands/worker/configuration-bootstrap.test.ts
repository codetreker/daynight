import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { createWorkerConfigurationBootstrap } from "../../../src/commands/worker/configuration-bootstrap.js";
import type { WorkerConfigurationBootstrap } from "../../../src/commands/worker/configuration-bootstrap.js";
import type { WorkerBootstrapProjectResolver } from "../../../src/commands/worker/configuration-source.js";
import { WorkerBootstrapIdentityError } from "../../../src/commands/worker/configuration-source.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const id = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
const connection = { serverUrl: identity.serverOrigin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: identity.workerId };
const repository = (value: number) => ({ projectId: id(value), remote: `https://git.example/team/repo${value}.git`, path: `../repo${value}` });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};
const cancelled = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
  const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
});
const fixtures: { directory: string; provider: WorkerConfigurationBootstrap; release: (() => void)[] }[] = [];
const operations: Operation[] = [];
const operation = (signal?: AbortSignal): Operation => {
  const value = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 120_000 } });
  operations.push(value); return value;
};
const fixture = async (data: Record<string, unknown> = {}, resolveProject: WorkerBootstrapProjectResolver = async input => ({ id: input.projectId! })) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/configuration-bootstrap-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "run-"));
  vi.stubEnv("DN_CONFIG_DIR", path.join(directory, "configuration"));
  const paths = resolveWorkerPaths(directory);
  await mkdir(paths.stateDirectory);
  await writeFile(paths.configFile, stringify({ ...connection, ...data }));
  const root = new AbortController(), errors: unknown[] = [];
  const provider = createWorkerConfigurationBootstrap({ paths, identity, signal: root.signal, resolveProject, onError: error => { errors.push(error); } });
  const entry = { directory, provider, release: [] as (() => void)[] }; fixtures.push(entry);
  return { provider, paths, root, errors, entry, write: (value: Record<string, unknown>) => writeFile(paths.configFile, stringify({ ...connection, ...value })) };
};

afterEach(async () => {
  for (const value of operations.splice(0)) value.dispose();
  for (const current of fixtures) for (const release of current.release) release();
  await Promise.all(fixtures.map(current => current.provider.stop()));
  vi.useRealTimers(); vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(current => rm(current.directory, { recursive: true, force: true })));
});

describe("Worker configuration bootstrap preparation", () => {
  it("uses one current-file snapshot for the complete candidate and rereads the next pass", async () => {
    const entered = deferred(), release = deferred();
    const resolve = vi.fn<WorkerBootstrapProjectResolver>(async input => { entered.resolve(); await release.promise; return { id: input.projectId! }; });
    const original = { agentControlMode: "web", agent: "codex", model: "original", args: ["--original"], maxConcurrent: 3,
      toolPaths: { codex: path.join(path.parse(process.cwd()).root, "original", "codex") }, repositories: [repository(3)] };
    const f = await fixture({ worker: original }, resolve); f.entry.release.push(release.resolve);
    const first = f.provider.prepare(operation()); await entered.promise;
    await f.write({ worker: { agentControlMode: "herdr", agent: "claude", model: "replacement", maxConcurrent: 7, repositories: [] } });
    release.resolve();
    expect(await first).toMatchObject({ agentControlMode: "web", maxConcurrent: 3, native: { agent: "codex", model: "original", args: ["--original"] },
      projects: [{ projectId: id(3) }], toolPaths: { codex: { kind: "path", path: original.toolPaths.codex } } });
    expect(await f.provider.prepare(operation())).toMatchObject({ agentControlMode: "herdr", maxConcurrent: 7, native: { agent: "claude", model: "replacement" }, projects: [] });
    expect(resolve).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
  });

  it("shares the root pass when a report waiter is cancelled", async () => {
    const entered = deferred(), release = deferred(); let ownedSignal!: AbortSignal;
    const resolve = vi.fn<WorkerBootstrapProjectResolver>(async (input, signal) => { ownedSignal = signal; entered.resolve(); await release.promise; return { id: input.projectId! }; });
    const f = await fixture({ worker: { repositories: [repository(3)] } }, resolve); f.entry.release.push(release.resolve);
    const waiter = new AbortController(), first = f.provider.prepare(operation(waiter.signal));
    const rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
    await entered.promise; waiter.abort(new Error("Report period expired")); await rejected;
    expect(ownedSignal.aborted).toBe(false);
    const second = f.provider.prepare(operation()); release.resolve();
    expect(await second).toMatchObject({ projects: [{ projectId: id(3) }] });
    expect(resolve).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
  });

  it("bounds the shared pass at 60 seconds and reuses only successful same-source resolutions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = deferred(); let secondAttempts = 0;
    const resolve = vi.fn<WorkerBootstrapProjectResolver>(async (input, signal) => {
      if (input.projectId === id(4) && secondAttempts++ === 0) { entered.resolve(); return cancelled(signal); }
      return { id: input.projectId! };
    });
    const f = await fixture({ worker: { repositories: [repository(3), repository(4)] } }, resolve);
    const first = f.provider.prepare(operation()), rejected = expect(first).rejects.toMatchObject({ kind: "deadline" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(59_999); expect(resolve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(f.errors).toHaveLength(1); expect(f.errors[0]).toBeInstanceOf(OperationError);
    expect(await f.provider.prepare(operation())).toMatchObject({ projects: [{ projectId: id(3) }, { projectId: id(4) }] });
    expect(resolve.mock.calls.map(([input]) => input.projectId)).toEqual([id(3), id(4), id(4)]);
  });

  it("invalidates successful resolution after rejection and after a source change", async () => {
    const resolve = vi.fn<WorkerBootstrapProjectResolver>(async input => ({ id: input.projectId! }));
    const f = await fixture({ worker: { repositories: [repository(3)] } }, resolve);
    await f.provider.prepare(operation()); await f.provider.prepare(operation()); expect(resolve).toHaveBeenCalledOnce();
    f.provider.invalidate(); await f.provider.prepare(operation()); expect(resolve).toHaveBeenCalledTimes(2);
    await f.write({ worker: { repositories: [repository(3)], maxConcurrent: 9 } });
    await f.provider.prepare(operation()); expect(resolve).toHaveBeenCalledTimes(3);
    await f.provider.clear(); await f.provider.prepare(operation()); expect(resolve).toHaveBeenCalledTimes(4);
  });

  it("cancels and joins a superseded pass before clearing its resolution scope", async () => {
    const entered = deferred(), observedAbort = deferred(), release = deferred();
    const resolve = vi.fn<WorkerBootstrapProjectResolver>(async (input, signal) => {
      if (resolve.mock.calls.length === 1) {
        entered.resolve(); signal.addEventListener("abort", () => { observedAbort.resolve(); }, { once: true });
        await release.promise;
      }
      return { id: input.projectId! };
    });
    const f = await fixture({ worker: { repositories: [repository(3)] } }, resolve); f.entry.release.push(release.resolve);
    const first = f.provider.prepare(operation()), rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
    await entered.promise;
    let drained = false; const clearing = f.provider.clear().then(() => { drained = true; });
    await observedAbort.promise; expect(drained).toBe(false);
    release.resolve(); await clearing; await rejected;
    expect(await f.provider.prepare(operation())).toMatchObject({ projects: [{ projectId: id(3) }] });
    expect(resolve).toHaveBeenCalledTimes(2); expect(f.errors).toEqual([]);
  });

  it.each(["serverUrl", "workerId"] as const)("rejects changed local %s without resolving or rewriting identity", async field => {
    const resolve = vi.fn<WorkerBootstrapProjectResolver>(async input => ({ id: input.projectId! }));
    const f = await fixture({ [field]: field === "serverUrl" ? "https://different.example" : id(9), worker: { repositories: [repository(3)] } }, resolve);
    const before = await readFile(f.paths.configFile, "utf8");
    await expect(f.provider.prepare(operation())).rejects.toMatchObject({ field });
    expect(f.errors[0]).toBeInstanceOf(WorkerBootstrapIdentityError);
    expect(resolve).not.toHaveBeenCalled(); expect(await readFile(f.paths.configFile, "utf8")).toBe(before);
  });

  it("keeps frozen credentials and identity when the current source omits an identity or changes its token", async () => {
    const f = await fixture({ workerId: undefined, serverUrl: "HTTPS://DAYNIGHT.EXAMPLE/", serverToken: "dn_pat_zyxwvutsrqponmlkjihgfedcba1234567890", worker: { maxConcurrent: 6 } });
    const before = await readFile(f.paths.configFile, "utf8");
    expect(await f.provider.prepare(operation())).toMatchObject({ maxConcurrent: 6, projects: [] });
    expect(await readFile(f.paths.configFile, "utf8")).toBe(before); expect(f.errors).toEqual([]);
  });

  it("root cancellation joins the pass and prevents another preparation", async () => {
    const entered = deferred(), exited = deferred();
    const f = await fixture({ worker: { repositories: [repository(3)] } }, async (_input, signal) => {
      entered.resolve(); try { return await cancelled(signal); } finally { exited.resolve(); }
    });
    const pending = f.provider.prepare(operation()), rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await entered.promise; const reason = new Error("Worker stopping"); f.root.abort(reason);
    await f.provider.stop(); await exited.promise; await rejected;
    expect(() => f.provider.prepare(operation())).toThrow(reason); expect(f.errors).toEqual([]);
  });
});
