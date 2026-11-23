import { IDBObjectStore } from "fake-indexeddb";
import { openDB } from "idb";
import type { ProjectPersonVersion } from "../src/api/auth-types";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from "../src/features/task-cache/database";
import { afterEach, expect, it, vi } from "vitest";
import { getTask, getTaskSync, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { TaskAssignees } from "../src/features/task-assignees/TaskAssignees";
import { createTaskCacheScope, type CacheEvent, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from "./helpers/taskSync";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const personId = "30000000-0000-4000-8000-000000000001";
const otherId = "30000000-0000-4000-8000-000000000002";
const person = (userId = personId, name: string | null = "Current person", hasProjectAccess = true) => ({ userId, version: TEST_PROFILE_VERSION, name, avatarUrl: null, hasProjectAccess });
const signal = () => new AbortController().signal;
type PendingRequest = { readonly url: URL; readonly signal: AbortSignal; readonly finish: (value: Response) => void };
const owners: TaskAssignees[] = [], scopes: TaskCacheScope[] = [], requests: PendingRequest[] = [];
const response = (items: readonly ReturnType<typeof person>[], unresolvedUserIds: readonly string[] = []) => new Response(JSON.stringify({ items, unresolvedUserIds }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": TEST_VIEWER_ID } });
const denial = (principal: string | null = TEST_VIEWER_ID) => new Response(JSON.stringify({ error: { code: "not_found", message: "Project is unavailable", requestId: "people-denied" } }), { status: 404, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const manifest = (ids = [personId, otherId], version = TEST_PROFILE_VERSION, hasProjectAccess = true): readonly ProjectPersonVersion[] => ids.map((userId) => ({ userId, version, hasProjectAccess }));
const apply = async (cache: TaskCacheScope, epoch?: string, assigneeVersions = manifest()) => {
  const detail = detailFixture(projectId, taskId);
  const ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { query: epoch === undefined && ticket.epoch !== null ? { epoch: ticket.epoch } : {}, ...(epoch === undefined ? {} : { epoch }), assigneeVersions, versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
};
const harness = async () => {
  const cache = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { void cache.invalidateScope(); } }); scopes.push(cache); await apply(cache);
  const owner = new TaskAssignees(cache); owners.push(owner);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => new Promise<Response>((finish) => requests.push({ url: new URL(url, location.origin), signal: options.signal!, finish })));
  vi.stubGlobal("fetch", fetcher);
  return { cache, owner, fetcher };
};
const count = async (value: number) => vi.waitFor(() => expect(requests).toHaveLength(value));
const settle = async (index: number, items?: readonly ReturnType<typeof person>[], unresolvedUserIds: readonly string[] = []) => {
  const request = requests[index]!;
  request.finish(response(items ?? request.url.searchParams.getAll("userId").map((id) => person(id)), unresolvedUserIds));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.dispose()); scopes.splice(0).forEach((cache) => cache.dispose());
  for (const request of requests.splice(0)) request.finish(response([]));
  invalidateAuthRequests(); vi.unstubAllGlobals();
});

it("does not read people for empty demand or an unadmitted preview receipt", async () => {
  const { owner, fetcher } = await harness(); const rows = Symbol(), graph = Symbol();
  owner.setDemand(projectId, rows, []); owner.receipt(projectId, graph, 1);
  await Promise.resolve(); expect(fetcher).not.toHaveBeenCalled();
  owner.removeReceipt(projectId, graph); owner.setDemand(projectId, rows, [personId]); owner.receipt(projectId, graph, 0);
  await Promise.resolve(); expect(fetcher).not.toHaveBeenCalled();
});

it.each([100, 101])("coalesces overlapping mounted demand into bounded batches for %i people", async (size) => {
  const { owner, cache } = await harness();
  const ids = Array.from({ length: size }, (_, index) => `30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
  await apply(cache, undefined, manifest(ids));
  const begin = vi.spyOn(cache, "beginSync"), read = vi.spyOn(cache, "readProject");
  owner.setDemand(projectId, Symbol(), ids); owner.setDemand(projectId, Symbol(), ids.slice(0, 5)); owner.receipt(projectId, Symbol(), 1);
  await count(Math.ceil(size / 100));
  expect(requests.flatMap((request) => request.url.searchParams.getAll("userId"))).toEqual([...ids].sort());
  expect(requests.every((request) => request.url.searchParams.getAll("userId").length <= 100)).toBe(true);
  for (let index = 0; index < requests.length; index++) await settle(index);
  await vi.waitFor(() => expect(owner.snapshot(projectId).people.size).toBe(size));
  expect(begin).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it("reuses loaded identities across task openings, empty deltas and remounted graph owners", async () => {
  const { owner } = await harness(); const graph = Symbol(), row = Symbol();
  owner.setDemand(projectId, row, [personId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  owner.receipt(projectId, graph, 1); owner.receipt(projectId, graph, 2);
  owner.removeDemand(projectId, row); await Promise.resolve(); owner.setDemand(projectId, Symbol(), [personId]);
  owner.removeReceipt(projectId, graph); owner.receipt(projectId, Symbol(), 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(1); expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
});

it("keeps shared in-flight identities alive and resolves only newly missing demand afterward", async () => {
  const { owner } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  owner.setDemand(projectId, Symbol(), [personId, otherId]);
  owner.receipt(projectId, graph, 2); owner.receipt(projectId, graph, 3); await Promise.resolve();
  expect(requests).toHaveLength(1); expect(requests[0]!.signal.aborted).toBe(false);
  await settle(0); await count(2); expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([otherId]);
  await settle(1); await Promise.resolve(); expect(requests).toHaveLength(2);
  expect([...owner.snapshot(projectId).people.keys()].sort()).toEqual([personId, otherId]);
});

it("queries only missing identities while caching nullable profiles and unresolved IDs", async () => {
  const { owner, cache } = await harness(); const row = Symbol(), graph = Symbol();
  owner.setDemand(projectId, row, [personId, otherId]); owner.receipt(projectId, graph, 1); await count(1);
  await settle(0, [person(personId, null)], [otherId]);
  await apply(cache, undefined, manifest([personId]));
  owner.receipt(projectId, graph, 2); owner.removeDemand(projectId, row); await Promise.resolve();
  owner.setDemand(projectId, row, [personId, otherId]); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(1); expect(owner.snapshot(projectId).people.get(personId)?.name).toBeNull();
  expect(owner.snapshot(projectId).unresolvedUserIds.has(otherId)).toBe(true);
  const missingId = "30000000-0000-4000-8000-000000000003";
  await apply(cache, undefined, manifest([personId, missingId]));
  owner.setDemand(projectId, row, [personId, otherId, missingId]); await count(2);
  expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([missingId]); await settle(1);
});

it("builds a complete catalogue from the live manifest and shares only missing profiles", async () => {
  const { owner } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1);
  await count(1); await settle(0);
  owner.openCatalogue(projectId); await count(2);
  expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([otherId]);
  owner.openCatalogue(projectId); owner.retryCatalogue(projectId); await Promise.resolve(); expect(requests).toHaveLength(2);
  await settle(1); await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  owner.openCatalogue(projectId); owner.retryCatalogue(projectId); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(2); expect(owner.snapshot(projectId).items).toEqual([person(), person(otherId)]);
});

it("keeps catalogue failures visible and retries only missing profiles", async () => {
  const { owner } = await harness(); owner.openCatalogue(projectId); await count(1);
  requests[0]!.finish(new Response("broken", { headers: { "Daynight-User-ID": TEST_VIEWER_ID } }));
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("error"));
  owner.openCatalogue(projectId); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(requests).toHaveLength(1);
  owner.retryCatalogue(projectId); await count(2); await settle(1);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready")); expect(owner.snapshot(projectId).error).toBeNull();
});

it("retains a valid response after demand changes and resolves the new missing demand once", async () => {
  const { owner } = await harness(); const rows = Symbol();
  owner.setDemand(projectId, rows, [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  owner.setDemand(projectId, rows, [otherId]); await Promise.resolve(); await settle(0); await count(2);
  expect(owner.snapshot(projectId).people.has(personId)).toBe(true);
  expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([otherId]);
  await settle(1); await vi.waitFor(() => expect(owner.snapshot(projectId).people.has(otherId)).toBe(true));
});

it("keeps one lookup when the same task closes and reopens during its pending request", async () => {
  const { owner } = await harness(); const row = Symbol();
  owner.setDemand(projectId, row, [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  owner.removeDemand(projectId, row); await Promise.resolve(); owner.setDemand(projectId, Symbol(), [personId]);
  await Promise.resolve(); expect(requests).toHaveLength(1); await settle(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(1); expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
});

it("reuses unchanged profile content after a task history replacement", async () => {
  const { owner, cache } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  await apply(cache, "40000000-0000-4000-8000-000000000002"); owner.receipt(projectId, graph, 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(1); expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
});

it("waits for identity revalidation before adopting a positive response", async () => {
  const { owner } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  const resume = pauseAuthRequests(); await settle(0); expect(owner.snapshot(projectId).people.size).toBe(0);
  resume(); await vi.waitFor(() => expect(owner.snapshot(projectId).people.has(personId)).toBe(true));
});

it("stops the people admission retry after a retained scope observes a different principal", async () => {
  let resume = () => {};
  const cache = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { resume = pauseAuthRequests(); } });
  scopes.push(cache); await apply(cache);
  const owner = new TaskAssignees(cache); owners.push(owner);
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, options: RequestInit) => new Promise<Response>((finish) => requests.push({ url: new URL(url, location.origin), signal: options.signal!, finish }))));
  const row = Symbol(); owner.setDemand(projectId, row, [personId]); owner.receipt(projectId, Symbol(), 1);
  await count(1); await settle(0);
  const projection = cache.getAuthorizedProject(projectId);
  owner.setDemand(projectId, row, [personId, otherId]); await count(2);
  const ready = cache.ready.bind(cache); let attempts = 0, exceeded = false;
  vi.spyOn(cache, "ready").mockImplementation(async (requestSignal) => {
    if (cache.hasIdentityMismatch && ++attempts > 10) { exceeded = true; resume(); throw new Error("Identity admission retried indefinitely"); }
    return ready(requestSignal);
  });
  try {
    requests[1]!.finish(denial("40000000-0000-4000-8000-000000000001"));
    await vi.waitFor(() => expect(cache.hasIdentityMismatch).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(exceeded).toBe(false); expect(attempts).toBe(1);
    expect(cache.signal.aborted).toBe(false); expect(cache.isInvalidated).toBe(false);
    expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
    expect(owner.snapshot(projectId).people.has(otherId)).toBe(false);
    expect(requests).toHaveLength(2);
  } finally { resume(); }
  expect(cache.getAuthorizedProject(projectId)).toBe(projection);
});

it("keeps published people when identity changes between readiness and publication", async () => {
  const mismatch = vi.fn();
  const cache = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: mismatch }); scopes.push(cache); await apply(cache);
  const owner = new TaskAssignees(cache); owners.push(owner);
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, options: RequestInit) => new Promise<Response>((finish) => requests.push({ url: new URL(url, location.origin), signal: options.signal!, finish }))));
  const row = Symbol(); owner.setDemand(projectId, row, [personId]); owner.receipt(projectId, Symbol(), 1);
  await count(1); await settle(0);
  const projection = cache.getAuthorizedProject(projectId);
  owner.setDemand(projectId, row, [personId, otherId]); await count(2);
  const ready = cache.ready.bind(cache); let triggered = false, failure: unknown;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: { "Daynight-User-ID": "40000000-0000-4000-8000-000000000001" } })));
  vi.spyOn(cache, "ready").mockImplementation(async (requestSignal) => {
    await ready(requestSignal);
    if (!triggered) {
      triggered = true;
      try { await getTask(projectId, taskId, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: cache.principalMismatch }); }
      catch (error) { failure = error; }
    }
  });
  await settle(1);
  await vi.waitFor(() => expect(mismatch).toHaveBeenCalledOnce());
  expect(failure).toMatchObject({ kind: "protocol", code: "principal_mismatch" });
  expect(cache.signal.aborted).toBe(false); expect(cache.getAuthorizedProject(projectId)).toBe(projection);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
  expect(owner.snapshot(projectId).people.has(otherId)).toBe(false);
});

it("retains known identity on a missing profile read failure and retries only the missing ID", async () => {
  const { owner } = await harness(); const graph = Symbol(), row = Symbol(); owner.setDemand(projectId, row, [personId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  owner.setDemand(projectId, row, [personId, otherId]); await count(2);
  requests[1]!.finish(new Response("broken", { headers: { "Daynight-User-ID": TEST_VIEWER_ID } }));
  await vi.waitFor(() => expect(owner.snapshot(projectId).error).not.toBeNull());
  expect(owner.snapshot(projectId).people.get(personId)?.hasProjectAccess).toBe(true);
  owner.receipt(projectId, graph, 2); await count(3); expect(requests[2]!.url.searchParams.getAll("userId")).toEqual([otherId]);
  await settle(2); expect(owner.snapshot(projectId).error).toBeNull();
});

it("withdraws the captured project on a trusted 404 after demand removal even while positive work is paused", async () => {
  const { owner, cache } = await harness(); const rows = Symbol(); owner.setDemand(projectId, rows, [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  const events: CacheEvent[] = []; cache.subscribe((event) => events.push(event));
  owner.removeDemand(projectId, rows); const resume = pauseAuthRequests(); requests[0]!.finish(denial());
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ accessRevoked: true })));
  expect(owner.snapshot(projectId).people.size).toBe(0); resume();
  expect(cache.getAuthorizedProject(projectId)).toBeNull();
  await vi.waitFor(() => expect(owner.snapshot(projectId).error).toMatchObject({ status: 404, code: "not_found" }));
});

it.each([null, "40000000-0000-4000-8000-000000000001"])("does not trust a denial without the admitted principal %#", async (principal) => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  requests[0]!.finish(denial(principal));
  if (principal === null) {
    await vi.waitFor(() => expect(owner.snapshot(projectId).error).not.toBeNull());
    expect(cache.getAuthorizedProject(projectId)).not.toBeNull();
  } else { await vi.waitFor(() => expect(cache.isInvalidated).toBe(true)); await cache.invalidateScope(); }
  expect(owner.snapshot(projectId).people.size).toBe(0);
});

it("ignores an old history's late 404 after a new project history is admitted", async () => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  const oldGeneration = cache.getAuthorizedProject(projectId)!.manifest.cacheGeneration;
  await apply(cache, "40000000-0000-4000-8000-000000000002");
  const current = cache.getAuthorizedProject(projectId)!; expect(current.manifest.cacheGeneration).not.toBe(oldGeneration);
  requests[0]!.finish(denial()); await count(2); await settle(1);
  expect(cache.getAuthorizedProject(projectId)).toBe(current);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person()); expect(owner.snapshot(projectId).error).toBeNull();
});

it("exposes cleanup failure while retaining immediate denial of the captured project", async () => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "projects" && (args[0] as { state?: string }).state === "invalidated") throw new DOMException("Injected cleanup failure", "QuotaExceededError");
    return original.apply(this, args);
  });
  requests[0]!.finish(denial());
  await vi.waitFor(() => expect(owner.snapshot(projectId).error).toMatchObject({ category: "storage" }));
  expect(cache.getAuthorizedProject(projectId)).toBeNull(); expect(owner.snapshot(projectId).people.size).toBe(0);
});

it("fetches only changed profiles and updates access-only observations without avatar bytes", async () => {
  const { owner, cache } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId, otherId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  const changedVersion = "b".repeat(64);
  await apply(cache, undefined, [{ userId: personId, version: changedVersion, hasProjectAccess: true }, { userId: otherId, version: TEST_PROFILE_VERSION, hasProjectAccess: false }]);
  await count(2); expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([personId]);
  await settle(1, [{ ...person(), version: changedVersion, name: "Changed profile" }]);
  expect(owner.snapshot(projectId).people.get(otherId)?.hasProjectAccess).toBe(false);
  expect(owner.snapshot(projectId).people.get(personId)?.name).toBe("Changed profile");
});

it("stores the GET's actual version when a profile changes after the sync snapshot", async () => {
  const { owner, cache } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  const newer = { ...person(), version: "b".repeat(64), name: "Newer content" }; await settle(0, [newer]);
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(requests).toHaveLength(1);
  await apply(cache, undefined, manifest([personId, otherId], newer.version));
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(requests).toHaveLength(1);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(newer);
});

it("rejects an old profile after the live manifest changes during its lookup", async () => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  const newer = { ...person(), version: "b".repeat(64), name: "Newer content" };
  await apply(cache, undefined, manifest([personId, otherId], newer.version)); await settle(0);
  await count(2); expect(owner.snapshot(projectId).people.has(personId)).toBe(false); await settle(1, [newer]);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(newer);
});

it("hydrates matching persistent profiles after reload without another people request", async () => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1); await settle(0);
  const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await vi.waitFor(async () => expect(await database.get("profiles", [TEST_VIEWER_ID, projectId, personId])).toBeDefined()); database.close();
  owner.dispose(); cache.dispose();
  const next = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(next);
  const reloaded = new TaskAssignees(next); owners.push(reloaded); reloaded.setDemand(projectId, Symbol(), [personId]); reloaded.receipt(projectId, Symbol(), 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(reloaded.snapshot(projectId).people.size).toBe(0);
  await apply(next); await vi.waitFor(() => expect(reloaded.snapshot(projectId).people.get(personId)).toEqual(person()));
  expect(requests).toHaveLength(1);
});

it("starts a catalogue opened before online admission even for an unassigned empty delta", async () => {
  const { owner, cache } = await harness(); owner.dispose(); cache.dispose();
  const next = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(next);
  const reloaded = new TaskAssignees(next); owners.push(reloaded); reloaded.openCatalogue(projectId);
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(requests).toHaveLength(0);
  await apply(next); await count(1); await settle(0);
  await vi.waitFor(() => expect(reloaded.snapshot(projectId).status).toBe("ready"));
});

it("resolves absent manifest IDs without a global people lookup", async () => {
  const { owner, cache } = await harness(); await apply(cache, undefined, []);
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1);
  await vi.waitFor(() => expect(owner.snapshot(projectId).unresolvedUserIds.has(personId)).toBe(true)); expect(requests).toHaveLength(0);
});

it("retains in-memory profiles and exposes persistence failure without downloading them again", async () => {
  const { owner, cache } = await harness(); const graph = Symbol();
  const write = vi.spyOn(cache, "writeProfiles").mockRejectedValueOnce(new Error("Disk unavailable"));
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  await vi.waitFor(() => expect(owner.snapshot(projectId).error).toMatchObject({ message: "Disk unavailable" }));
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
  owner.receipt(projectId, graph, 2); await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(requests).toHaveLength(1); await vi.waitFor(() => expect(owner.snapshot(projectId).error).toBeNull());
});

it("cancels the owner lifetime and prevents late publication after account scope disposal", async () => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  cache.dispose(); expect(requests[0]!.signal.aborted).toBe(true); await settle(0);
  expect(owner.snapshot(projectId).people.size).toBe(0); expect(cache.isInvalidated).toBe(true);
});

it("exposes corrupted stored profiles once and lets Retry reload their cleared content", async () => {
  const { owner, cache } = await harness(); const ticket = await cache.beginSync(projectId, signal());
  const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await database.put("profiles", { userId: TEST_VIEWER_ID, projectId, profileUserId: personId, userFence: ticket.userFence,
    profile: { ...person(), version: "invalid" } }); database.close();
  owner.openCatalogue(projectId); await vi.waitFor(() => expect(owner.snapshot(projectId).error).toMatchObject({ category: "corrupt" }));
  expect(requests).toHaveLength(0); owner.retryCatalogue(projectId); await count(1); await settle(0);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready")); expect(owner.snapshot(projectId).error).toBeNull();
});


it("rechecks an ahead-of-sync profile after a fresh graph observation reports reverted content", async () => {
  const { owner, cache } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  await settle(0, [{ ...person(), version: "b".repeat(64), name: "Profile B" }]);
  expect(owner.snapshot(projectId).people.get(personId)?.name).toBe("Profile B");
  await apply(cache); owner.receipt(projectId, graph, 2); await count(2);
  expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([personId]); await settle(1);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
});

it("rechecks an unresolved race after a fresh graph observation restores the same qualification token", async () => {
  const { owner, cache } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  await settle(0, [], [personId]); expect(owner.snapshot(projectId).unresolvedUserIds.has(personId)).toBe(true);
  owner.setDemand(projectId, Symbol(), [personId]); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(requests).toHaveLength(1);
  await apply(cache); owner.receipt(projectId, graph, 2); await count(2); await settle(1);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
  expect(owner.snapshot(projectId).unresolvedUserIds.has(personId)).toBe(false);
});

it.each([false, true])("does not reinstall a conflicting lookup observed before a newer graph receipt (unresolved: %s)", async (unresolved) => {
  const { owner, cache } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  await apply(cache); owner.receipt(projectId, graph, 2);
  await settle(0, unresolved ? [] : [{ ...person(), version: "b".repeat(64), name: "Obsolete profile B" }], unresolved ? [personId] : []);
  await count(2); expect(owner.snapshot(projectId).people.has(personId)).toBe(false);
  await settle(1); expect(owner.snapshot(projectId).people.get(personId)).toEqual(person());
});


class CrossTabChannel {
  static channels = new Set<CrossTabChannel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { CrossTabChannel.channels.add(this); }
  postMessage(value: unknown): void {
    for (const channel of CrossTabChannel.channels) if (channel !== this && channel.name === this.name) {
      queueMicrotask(() => channel.onmessage?.({ data: value } as MessageEvent<unknown>));
    }
  }
  close(): void { CrossTabChannel.channels.delete(this); }
}

it("withdraws a ready catalogue after a peer replaces task history until a fresh local manifest validates its cached content", async () => {
  vi.stubGlobal("BroadcastChannel", CrossTabChannel);
  const { owner, cache, fetcher } = await harness(); owner.openCatalogue(projectId); await count(1); await settle(0);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  const previousGeneration = cache.getAuthorizedProject(projectId)!.manifest.cacheGeneration;
  expect(owner.snapshot(projectId).items.map((profile) => profile.hasProjectAccess)).toEqual([true, true]);
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  await apply(peer); await apply(peer, "40000000-0000-4000-8000-000000000003", manifest([personId, otherId], TEST_PROFILE_VERSION, false));
  await vi.waitFor(() => expect(cache.getAuthorizedProject(projectId)!.manifest.cacheGeneration).not.toBe(previousGeneration));
  expect(cache.getAuthorizedProject(projectId)!.assigneeVersions).toBeNull();
  expect(owner.snapshot(projectId).people.size).toBe(0); expect(owner.snapshot(projectId).items).toEqual([]);
  expect(owner.snapshot(projectId).unresolvedUserIds.size).toBe(0); expect(owner.snapshot(projectId).status).toBe("loading");
  const ticket = await cache.beginSync(projectId, signal()); fetcher.mockRejectedValueOnce(new TypeError("Local sync unavailable"));
  await expect(getTaskSync(projectId, { epoch: ticket.epoch! }, TEST_VIEWER_ID, signal())).rejects.toMatchObject({ kind: "network" });
  owner.openCatalogue(projectId); owner.retryCatalogue(projectId);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(owner.snapshot(projectId).people.size).toBe(0); expect(owner.snapshot(projectId).status).toBe("loading"); expect(requests).toHaveLength(1);
  await apply(cache, undefined, manifest([personId, otherId], TEST_PROFILE_VERSION, false));
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  expect(owner.snapshot(projectId).items).toEqual([person(personId, "Current person", false), person(otherId, "Current person", false)]);
  expect(requests).toHaveLength(1);
});

it("rejects a pending old-history profile after a peer replacement and reuses matching raw content after local revalidation", async () => {
  vi.stubGlobal("BroadcastChannel", CrossTabChannel);
  const { owner, cache } = await harness(); owner.openCatalogue(projectId); await count(1); await settle(0);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  const newer = { ...person(), version: "b".repeat(64), name: "Retired history profile" };
  await apply(cache, undefined, [{ userId: personId, version: newer.version, hasProjectAccess: true }, ...manifest([otherId])]); await count(2);
  const previousGeneration = cache.getAuthorizedProject(projectId)!.manifest.cacheGeneration;
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  await apply(peer); await apply(peer, "40000000-0000-4000-8000-000000000004");
  await vi.waitFor(() => expect(cache.getAuthorizedProject(projectId)!.manifest.cacheGeneration).not.toBe(previousGeneration));
  expect(cache.getAuthorizedProject(projectId)!.assigneeVersions).toBeNull();
  expect(owner.snapshot(projectId).people.size).toBe(0); expect(owner.snapshot(projectId).status).toBe("loading");
  await settle(1, [newer]);
  expect(owner.snapshot(projectId).people.size).toBe(0); expect(owner.snapshot(projectId).items).toEqual([]); expect(requests).toHaveLength(2);
  await apply(cache); await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person()); expect(requests).toHaveLength(2);
});

it('withdraws all people on scope suspension and rejects a pending profile from the same generation', async () => {
  const { owner, cache } = await harness();
  owner.openCatalogue(projectId); await count(1); await settle(0);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe('ready'));
  expect(owner.snapshot(projectId).people.size).toBe(2);
  const old = await cache.beginSync(projectId, signal());
  const changed = { ...person(), version: 'b'.repeat(64), name: 'Pending old profile' };
  await apply(cache, undefined, [{ userId: personId, version: changed.version, hasProjectAccess: true }, ...manifest([otherId])]);
  await count(2);
  cache.suspendProject(projectId);
  expect(owner.snapshot(projectId).people.size).toBe(0);
  expect(owner.snapshot(projectId).items).toEqual([]);
  expect(owner.snapshot(projectId).unresolvedUserIds.size).toBe(0);
  await settle(1, [changed]);
  expect(owner.snapshot(projectId).people.size).toBe(0);
  cache.resumeProject(projectId);
  await apply(cache, undefined, [{ userId: personId, version: changed.version, hasProjectAccess: true }, ...manifest([otherId])]);
  const current = await cache.beginSync(projectId, signal());
  expect(current.cacheGeneration).toBe(old.cacheGeneration);
  expect(current.scopeRevision).not.toBe(old.scopeRevision);
  await count(3);
  expect(owner.snapshot(projectId).people.has(personId)).toBe(false);
  await settle(2, requests[2]!.url.searchParams.getAll('userId').map((id) => id === personId ? changed : person(id)));
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe('ready'));
  expect(owner.snapshot(projectId).people.get(personId)?.name).toBe(changed.name);
});

it('does not withdraw a project for an older people read after a newer Project observation', async () => {
  const { owner, cache } = await harness();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1);
  await count(1);
  cache.markProjectReadable(projectId);
  requests[0]!.finish(denial());
  await vi.waitFor(() => expect(owner.snapshot(projectId).error).toMatchObject({ status: 404, code: 'not_found' }));
  expect(cache.getAuthorizedProject(projectId)).not.toBeNull();
});

it('keeps accepted people when an older Project denial arrives', async () => {
  const { owner, cache } = await harness();
  const ticket = await cache.beginSync(projectId, signal());
  const revision = cache.getProjectReadRevision(projectId);
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1);
  await count(1); await settle(0);
  await vi.waitFor(() => expect(owner.snapshot(projectId).people.get(personId)?.name).toBe('Current person'));
  expect(cache.canRevokeProjectRead(ticket, revision)).toBe(false);
  expect(cache.getAuthorizedProject(projectId)).not.toBeNull();
});
