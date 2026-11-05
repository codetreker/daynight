import { waitFor } from "@testing-library/react";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskDetail } from "../src/api/types";
import type { StepsResource, TaskStep } from "../src/api/task-steps";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { readCachedDetail } from "../src/features/task-detail/detail-cache";
import { detailFixture, graphFixture, resourceResponse } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_VIEWER_ID } from "./helpers/taskSync";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const detail = (version = 5n): TaskDetail => detailFixture(projectId, taskId, {
  title: "Task", version, updatedAt: `2026-10-22T10:00:${version.toString().padStart(2, "0")}Z`,
});

const step: TaskStep = { id: "00000001", title: "Read", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
const resource = (version = 5n): StepsResource => ({ projectId, taskId, version, steps: [{ ...step, status: version === 5n ? "todo" : "done" }] });
const signal = () => new AbortController().signal;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const scopes: TaskCacheScope[] = [];
const sessions: TaskDetailSessions[] = [];
const createScope = () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  return scope;
};
const apply = async (scope: TaskCacheScope, value: TaskDetail) => {
  const ticket = await scope.beginSync(projectId, signal());
  await scope.applySync(ticket, taskSyncFromGraph(graphFixture([value]), {
    query: ticket.epoch === null ? {} : { epoch: ticket.epoch },
    versionForTask: () => value.version, propertiesForTask: () => value.properties,
  }), signal());
};
const node = (scope: TaskCacheScope) => scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)!;

afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  scopes.splice(0).forEach((scope) => scope.dispose());
});

it("reconciles an unknown Step write when another page advances the stored summary before its hint arrives", async () => {
  const scope = createScope();
  await apply(scope, detail());
  const other = createScope();
  await other.readProject(projectId, signal());
  const session = new TaskDetailSessions(scope);
  sessions.push(session);
  session.observe(projectId, taskId, node(scope));
  const parent = deferred<Response>();
  const steps = deferred<Response>();
  let submitted = false;
  let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Lost response")); }
    if (url.endsWith("/steps")) return submitted ? steps.promise.then((response) => response.clone()) : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    if (submitted) { parentReads++; return parent.promise.then((response) => response.clone()); }
    return Promise.resolve(resourceResponse(detail(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher);
  const releaseDetail = session.subscribe(projectId, taskId, vi.fn());
  const releaseSteps = session.subscribeSteps(projectId, taskId, vi.fn());
  session.load(projectId, taskId, 1, "open");
  session.loadSteps(projectId, taskId);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));

  // Another page can commit IndexedDB before this page receives its broadcast hint.
  const hints = vi.spyOn(BroadcastChannel.prototype, "postMessage").mockImplementation(() => {});
  session.setStepStatus(projectId, taskId, step.id, "done", 5n);
  await waitFor(() => expect(parentReads).toBe(1));
  await apply(other, detail(6n));
  expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n);
  steps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ refreshing: false, stale: true }));
  parent.resolve(resourceResponse(detail(6n), TEST_VIEWER_ID));
  await waitFor(async () => {
    const ticket = await scope.beginSync(projectId, signal());
    expect(await readCachedDetail(scope, ticket, taskId, signal())).toMatchObject({ version: 6n });
  });
  expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n);

  hints.mockRestore();
  await scope.readProject(projectId, signal());
  session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId)).toMatchObject({
    detail: { version: 6n }, mutation: { phase: "reconciled", reconciledFrom: "unknown", reconciling: false, reconciliationError: null },
  });
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(6n), stale: false, error: null });
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  releaseSteps();
  releaseDetail();
});

it("leaves Step recovery retryable when a fresh parent cannot be saved to the detail cache", async () => {
  const scope = createScope();
  await apply(scope, detail());
  const session = new TaskDetailSessions(scope);
  sessions.push(session);
  session.observe(projectId, taskId, node(scope));
  const parent = deferred<Response>();
  const steps = deferred<Response>();
  let submitted = false;
  let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Lost response")); }
    if (url.endsWith("/steps")) return submitted ? steps.promise.then((response) => response.clone()) : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    if (submitted) { parentReads++; return parent.promise.then((response) => response.clone()); }
    return Promise.resolve(resourceResponse(detail(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher);
  const releaseDetail = session.subscribe(projectId, taskId, vi.fn());
  const releaseSteps = session.subscribeSteps(projectId, taskId, vi.fn());
  session.load(projectId, taskId, 1, "open");
  session.loadSteps(projectId, taskId);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, step.id, "done", 5n);
  await waitFor(() => expect(parentReads).toBe(1));
  await apply(scope, detail(6n));
  session.observe(projectId, taskId, node(scope));

  const put = IDBObjectStore.prototype.put;
  const storageFailure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === "details") throw new DOMException("The detail cache quota was exceeded", "QuotaExceededError");
    return put.call(this, value, key);
  });
  steps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID));
  parent.resolve(resourceResponse(detail(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({
    detail: { version: 6n }, mutation: { phase: "unknown", reconciling: false, reconciliationError: { category: "storage" } },
  }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false);

  storageFailure.mockRestore();
  session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciling: false, reconciliationError: null });
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  releaseSteps();
  releaseDetail();
});
