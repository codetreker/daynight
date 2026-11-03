import { waitFor } from '@testing-library/react';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTaskDetail, parseTaskGraph } from '../src/api/parse';
import { parseTaskSummary } from '../src/api/task-sync';
import type { TaskDetail, TaskSummary } from '../src/api/types';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { sameSummary } from '../src/features/task-cache/projection';
import { saveDetail } from '../src/features/task-detail/detail-cache';
import { isTaskStale, taskDescriptor, taskReviewKey } from '../src/features/task-detail/freshness';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { taskSyncFixture, taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const siblingId = '20000000-0000-4000-8000-000000000002';
const person = 'abcdef01-2345-4678-8abc-0123456789ab';
const otherPerson = 'abcdef01-2345-4678-8abc-0123456789ac';
const later = '2026-10-24T00:01:00Z';
const body = (changes: Partial<TaskDetail> = {}) => detailFixture(projectId, taskId, { title: 'Assignment task', assignedTo: null, version: 5n, ...changes });
const summary = (detail: TaskDetail): TaskSummary => taskSyncFromGraph(graphFixture([detail]), { versionForTask: () => detail.version, propertiesForTask: () => detail.properties }).tasks[0]!;
const wireSummary = (detail: TaskDetail) => taskSyncFixture(graphFixture([detail]), { versionForTask: () => detail.version, propertiesForTask: () => detail.properties }).tasks[0]!;
const signal = () => new AbortController().signal;
const scopes: TaskCacheScope[] = []; const sessions: TaskDetailSessions[] = []; const connections: IDBPDatabase<TaskCacheSchema>[] = [];
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const sync = async (scope: TaskCacheScope, details: readonly TaskDetail[]) => {
  const ticket = await scope.beginSync(projectId, signal());
  return scope.applySync(ticket, taskSyncFromGraph(graphFixture(details), { query: ticket.epoch === null ? {} : { epoch: ticket.epoch }, versionForTask: (node) => details.find((detail) => detail.id === node.id)!.version, propertiesForTask: (node) => details.find((detail) => detail.id === node.id)!.properties }), signal());
};
const seed = async (details: readonly TaskDetail[]) => { const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); await sync(scope, details); return scope; };
const inspect = async () => { const connection = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); connections.push(connection); return connection; };
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); scopes.splice(0).forEach((scope) => scope.dispose()); connections.splice(0).forEach((connection) => connection.close()); });

describe('required assignment in every task representation', () => {
  it.each([null, person])('preserves the explicit assignment %s in detail, graph and summary', (assignedTo) => {
    const detail = body({ assignedTo }); const graph = graphFixture([detail]);
    for (const parsed of [parseTaskDetail(detail, projectId, taskId), parseTaskGraph(graph, projectId).tasks[0], parseTaskSummary(wireSummary(detail))]) {
      expect(Object.hasOwn(parsed!, 'assignedTo')).toBe(true); expect(parsed!.assignedTo).toBe(assignedTo);
    }
  });
  it('canonicalizes UUID spelling consistently across detail, graph and summary', () => {
    const detail = body(); const graph = graphFixture([detail]); const assignedTo = person.toUpperCase();
    expect(parseTaskDetail({ ...detail, assignedTo }, projectId, taskId).assignedTo).toBe(person);
    expect(parseTaskGraph({ ...graph, tasks: [{ ...graph.tasks[0], assignedTo }] }, projectId).tasks[0]!.assignedTo).toBe(person);
    expect(parseTaskSummary({ ...wireSummary(detail), assignedTo }).assignedTo).toBe(person);
  });
  it.each([undefined, '', false, 0, {}, [], 'not-a-uuid', ` ${person}`, `${person} `])('rejects missing or malformed assignment %# in every parser', (assignedTo) => {
    const detail = body(); const graph = graphFixture([detail]);
    expect(() => parseTaskDetail({ ...detail, assignedTo }, projectId, taskId)).toThrow('invalid response');
    expect(() => parseTaskGraph({ ...graph, tasks: [{ ...graph.tasks[0], assignedTo }] }, projectId)).toThrow('invalid response');
    expect(() => parseTaskSummary({ ...wireSummary(detail), assignedTo })).toThrow('invalid response');
  });
  it('rejects an actually absent property rather than synthesizing an unassigned task', () => {
    const { assignedTo: _detailAssignment, ...detail } = body(); const graph = graphFixture([body()]); const { assignedTo: _graphAssignment, ...node } = graph.tasks[0]!; const { assignedTo: _summaryAssignment, ...row } = wireSummary(body());
    expect(() => parseTaskDetail(detail, projectId, taskId)).toThrow('invalid response'); expect(() => parseTaskGraph({ ...graph, tasks: [node] }, projectId)).toThrow('invalid response'); expect(() => parseTaskSummary(row)).toThrow('invalid response');
  });
});

describe('assignment freshness and review identity', () => {
  it.each([{ from: null, to: person }, { from: person, to: null }, { from: person, to: otherPerson }])('treats a same-version assignment change as new material %#', ({ from, to }) => {
    const detail = body({ assignedTo: from }); const changed = { ...detail, assignedTo: to }; const node = graphFixture([detail]).tasks[0]!; const changedNode = graphFixture([changed]).tasks[0]!;
    expect(sameSummary(summary(detail), summary(changed))).toBe(false); expect(isTaskStale(node, detail)).toBe(false); expect(isTaskStale(node, changed)).toBe(true);
    expect(taskDescriptor(node)).not.toBe(taskDescriptor(changedNode)); expect(taskReviewKey(detail)).not.toBe(taskReviewKey(changed));
    expect(sameSummary(summary(detail), summary({ ...detail }))).toBe(true); expect(taskDescriptor(node)).toBe(taskDescriptor({ ...node })); expect(taskReviewKey(detail)).toBe(taskReviewKey({ ...detail }));
  });
});

describe('assignment cache atomicity', () => {
  it.each([{ from: null, to: person }, { from: person, to: null }])('rejects a mixed batch containing a same-version assignment contradiction %#', async ({ from, to }) => {
    const original = body({ assignedTo: from }); const sibling = body({ id: siblingId, title: 'Sibling' }); const scope = await seed([original, sibling]); const initial = scope.getAuthorizedProject(projectId)!; const ticket = await scope.beginSync(projectId, signal());
    const writes: string[] = []; const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) { writes.push(this.name); return put.apply(this, args); });
    const updatedSibling = { ...sibling, assignedTo: person, version: sibling.version + 1n, updatedAt: later };
    const conflict = { ...original, assignedTo: to }; const details = [updatedSibling, conflict];
    const incoming = taskSyncFromGraph(graphFixture(details), { query: { epoch: ticket.epoch! }, versionForTask: (node) => details.find((detail) => detail.id === node.id)!.version, propertiesForTask: (node) => details.find((detail) => detail.id === node.id)!.properties });
    await expect(scope.applySync(ticket, incoming, signal())).rejects.toMatchObject({ kind: 'protocol' });
    expect(scope.getAuthorizedProject(projectId)).toBe(initial); expect(scope.getAuthorizedProject(projectId)?.manifest.maxUpdatedAt).toBe(initial.manifest.maxUpdatedAt); expect(writes).toEqual([]);
    const persisted = await inspect(); expect(await persisted.get('projects', [TEST_VIEWER_ID, projectId])).toEqual(initial.manifest);
    expect((await persisted.get('summaries', [TEST_VIEWER_ID, projectId, taskId]))!.summary).toEqual(summary(original)); expect((await persisted.get('summaries', [TEST_VIEWER_ID, projectId, siblingId]))!.summary).toEqual(summary(sibling));
    expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(ticket.maxUpdatedAt);
  });
  it('rejects a contradictory same-version detail while retaining its persisted assignment and watermark', async () => {
    const detail = body({ assignedTo: person }); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal()); await saveDetail(scope, ticket, detail, signal());
    await expect(saveDetail(scope, ticket, { ...detail, assignedTo: null }, signal())).rejects.toMatchObject({ kind: 'protocol' });
    const database = await inspect(); expect((await database.get('details', [TEST_VIEWER_ID, projectId, taskId]))!.detail.assignedTo).toBe(person); expect((await database.get('summaries', [TEST_VIEWER_ID, projectId, taskId]))!.summary.assignedTo).toBe(person);
    expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(ticket.maxUpdatedAt); expect(scope.getAuthorizedProject(projectId)?.index.nodes.get(taskId)?.assignedTo).toBe(person);
  });
});

it('retires an actual versionchanged scope before a pending detail response can publish or read the database again', async () => {
  const detail = body({ assignedTo: person, description: 'Private pending detail' }); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal()); const events = vi.fn(); scope.subscribe(events);
  const pending = deferred<Response>(); const fetcher = vi.fn().mockReturnValueOnce(pending.promise); vi.stubGlobal('fetch', fetcher);
  const session = new TaskDetailSessions(scope); sessions.push(session); const publish = vi.fn(); session.subscribe(projectId, taskId, publish); session.observe(projectId, taskId, scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)); session.load(projectId, taskId, 1, 'open');
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); const requestSignal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  const next = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA + 1); connections.push(next);
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ projectId, error: expect.objectContaining({ category: 'versionchange' }) })); expect(scope.isInvalidated).toBe(true); expect(scope.signal.aborted).toBe(true); expect(requestSignal.aborted).toBe(true);
  const gets = vi.spyOn(IDBObjectStore.prototype, 'get'); const getAll = vi.spyOn(IDBIndex.prototype, 'getAll'); const opens = vi.mocked(indexedDB.open); opens.mockClear(); publish.mockClear();
  await expect(scope.ready(signal())).rejects.toMatchObject({ name: 'AbortError' }); await expect(scope.beginSync(projectId, signal())).rejects.toMatchObject({ name: 'AbortError' }); await expect(scope.readProject(projectId, signal())).rejects.toMatchObject({ name: 'AbortError' }); await expect(scope.detailTransaction(ticket, signal(), async () => 'private')).rejects.toMatchObject({ name: 'AbortError' });
  const response = resourceResponse(detail, TEST_VIEWER_ID); const readBody = vi.spyOn(response, 'text'); pending.resolve(response); await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.snapshot(projectId, taskId).detail).toBeNull(); expect(publish).not.toHaveBeenCalled(); expect(readBody).not.toHaveBeenCalled(); expect(gets).not.toHaveBeenCalled(); expect(getAll).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
});
