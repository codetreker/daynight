import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { TaskAssignees } from "../src/features/task-assignees/TaskAssignees";
import { createTaskCacheScope, type CacheEvent, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_VIEWER_ID } from "./helpers/taskSync";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const personId = "30000000-0000-4000-8000-000000000001";
const otherId = "30000000-0000-4000-8000-000000000002";
const person = (userId = personId, name = "Current person", hasProjectAccess = true) => ({ userId, name, avatarUrl: null, hasProjectAccess });
const signal = () => new AbortController().signal;
type PendingRequest = { readonly url: URL; readonly signal: AbortSignal; readonly finish: (value: Response) => void };
const owners: TaskAssignees[] = [], scopes: TaskCacheScope[] = [], requests: PendingRequest[] = [];
const response = (items: readonly ReturnType<typeof person>[], unresolvedUserIds: readonly string[] = []) => new Response(JSON.stringify({ items, unresolvedUserIds }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": TEST_VIEWER_ID } });
const denial = (principal: string | null = TEST_VIEWER_ID) => new Response(JSON.stringify({ error: { code: "not_found", message: "Project is unavailable", requestId: "people-denied" } }), { status: 404, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const apply = async (cache: TaskCacheScope, epoch?: string) => {
  const detail = detailFixture(projectId, taskId);
  const ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { query: epoch === undefined && ticket.epoch !== null ? { epoch: ticket.epoch } : {}, ...(epoch === undefined ? {} : { epoch }), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
};
const harness = async () => {
  const cache = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(cache); await apply(cache);
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
  const begin = vi.spyOn(cache, "beginSync"), read = vi.spyOn(cache, "readProject");
  const ids = Array.from({ length: size }, (_, index) => `30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
  owner.setDemand(projectId, Symbol(), ids); owner.setDemand(projectId, Symbol(), ids.slice(0, 5)); owner.receipt(projectId, Symbol(), 1);
  await count(Math.ceil(size / 100));
  expect(requests.flatMap((request) => request.url.searchParams.getAll("userId"))).toEqual([...ids].sort());
  expect(requests.every((request) => request.url.searchParams.getAll("userId").length <= 100)).toBe(true);
  for (let index = 0; index < requests.length; index++) await settle(index);
  await vi.waitFor(() => expect(owner.snapshot(projectId).people.size).toBe(size));
  expect(begin).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it("refreshes on positive empty-delta receipts and a remounted graph owner's reset revision", async () => {
  const { owner } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  owner.receipt(projectId, graph, 1); await Promise.resolve(); expect(requests).toHaveLength(1);
  owner.receipt(projectId, graph, 2); await count(2); await settle(1);
  owner.removeReceipt(projectId, graph); owner.receipt(projectId, Symbol(), 1); await count(3); await settle(2);
  expect(requests.every((request) => request.url.searchParams.has("userId"))).toBe(true);
});

it("keeps a slow bounded read alive and coalesces receipts into one successor", async () => {
  const { owner } = await harness(); const graph = Symbol();
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  owner.receipt(projectId, graph, 2); owner.receipt(projectId, graph, 3); await Promise.resolve();
  expect(requests).toHaveLength(1); expect(requests[0]!.signal.aborted).toBe(false);
  await settle(0); await count(2); await settle(1); await Promise.resolve(); expect(requests).toHaveLength(2);
});

it("opens a catalogue only on demand and preserves newer bounded facts against a late catalogue", async () => {
  const { owner } = await harness(); owner.openCatalogue(projectId); await count(1);
  expect(requests[0]!.url.searchParams.size).toBe(0);
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(2);
  await settle(1, [person(personId, "Former member", false)]);
  await settle(0, [person(personId, "Old member", true)]);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person(personId, "Former member", false));
  expect(owner.snapshot(projectId).items).toEqual([person(personId, "Former member", false)]);
});

it("does not let a late catalogue restore a person made unresolved by a newer bounded read", async () => {
  const { owner } = await harness(); owner.openCatalogue(projectId); await count(1);
  owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(2);
  await settle(1, [], [personId]); await settle(0, [person()]);
  await vi.waitFor(() => expect(owner.snapshot(projectId).status).toBe("ready"));
  expect(owner.snapshot(projectId).unresolvedUserIds.has(personId)).toBe(true); expect(owner.snapshot(projectId).items).toEqual([]);
});

it("rejects an obsolete demand response before publishing and resolves the new demand once", async () => {
  const { owner } = await harness(); const rows = Symbol();
  owner.setDemand(projectId, rows, [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  owner.setDemand(projectId, rows, [otherId]); await Promise.resolve(); await settle(0); await count(2);
  expect(owner.snapshot(projectId).people.has(personId)).toBe(false);
  expect(requests[1]!.url.searchParams.getAll("userId")).toEqual([otherId]);
  await settle(1); await vi.waitFor(() => expect(owner.snapshot(projectId).people.has(otherId)).toBe(true));
});

it("waits for identity revalidation before adopting a positive response", async () => {
  const { owner } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  const resume = pauseAuthRequests(); await settle(0); expect(owner.snapshot(projectId).people.size).toBe(0);
  resume(); await vi.waitFor(() => expect(owner.snapshot(projectId).people.has(personId)).toBe(true));
});

it("retains known identity on unresolved and failed reads without fabricating lost access", async () => {
  const { owner } = await harness(); const graph = Symbol(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1); await settle(0);
  owner.receipt(projectId, graph, 2); await count(2); await settle(1, [], [personId]);
  expect(owner.snapshot(projectId).people.get(personId)?.hasProjectAccess).toBe(true);
  owner.receipt(projectId, graph, 3); await count(3); requests[2]!.finish(new Response("broken", { headers: { "Daynight-User-ID": TEST_VIEWER_ID } }));
  await vi.waitFor(() => expect(owner.snapshot(projectId).error).not.toBeNull());
  expect(owner.snapshot(projectId).people.get(personId)?.hasProjectAccess).toBe(true);
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
  } else await vi.waitFor(() => expect(cache.isInvalidated).toBe(true));
  expect(owner.snapshot(projectId).people.size).toBe(0);
});

it("ignores an old history's late 404 after a new project history is admitted", async () => {
  const { owner, cache } = await harness(); const graph = Symbol(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, graph, 1); await count(1);
  const oldGeneration = cache.getAuthorizedProject(projectId)!.manifest.cacheGeneration;
  await apply(cache, "40000000-0000-4000-8000-000000000002");
  const current = cache.getAuthorizedProject(projectId)!; expect(current.manifest.cacheGeneration).not.toBe(oldGeneration);
  owner.openCatalogue(projectId); await count(2); await settle(1, [person(personId, "New history")]);
  requests[0]!.finish(denial()); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(cache.getAuthorizedProject(projectId)).toBe(current);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person(personId, "New history"));
  expect(owner.snapshot(projectId).error).toBeNull();
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

it("does not let an older bounded response overwrite a newer catalogue observation", async () => {
  const { owner } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  owner.openCatalogue(projectId); await count(2); await settle(1, [person(personId, "New catalogue", false)]);
  await settle(0, [person(personId, "Older bounded read", true)]);
  expect(owner.snapshot(projectId).people.get(personId)).toEqual(person(personId, "New catalogue", false));
  expect(owner.snapshot(projectId).items).toEqual([person(personId, "New catalogue", false)]);
});

it("rejects an obsolete catalogue's option set when a newer catalogue finishes first", async () => {
  const { owner } = await harness(); owner.openCatalogue(projectId); await count(1); owner.openCatalogue(projectId); await count(2);
  await settle(1, [person(otherId, "Current option")]); await settle(0, [person(personId, "Obsolete option")]);
  expect(owner.snapshot(projectId).items).toEqual([person(otherId, "Current option")]);
  expect(owner.snapshot(projectId).people.has(personId)).toBe(false);
});

it("cancels the owner lifetime and prevents late publication after account scope disposal", async () => {
  const { owner, cache } = await harness(); owner.setDemand(projectId, Symbol(), [personId]); owner.receipt(projectId, Symbol(), 1); await count(1);
  cache.dispose(); expect(requests[0]!.signal.aborted).toBe(true); await settle(0);
  expect(owner.snapshot(projectId).people.size).toBe(0); expect(cache.isInvalidated).toBe(true);
});
