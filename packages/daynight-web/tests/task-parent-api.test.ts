import { afterEach, expect, it, vi } from 'vitest';
import { createTask, getTask, listTaskChildren } from '../src/api/client';
import { parseTaskDetail } from '../src/api/parse';
import { searchTasks } from '../src/api/task-search';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const project = '10000000-0000-4000-8000-000000000001';
const parent = '20000000-0000-4000-8000-000000000001';
const child = '20000000-0000-4000-8000-000000000002';
const other = '20000000-0000-4000-8000-000000000003';
const signal = () => new AbortController().signal;
const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed: vi.fn() };
const response = (body: unknown, status = 200) => wireResponse(body, { status, headers: viewerHeaders(TEST_VIEWER_ID) });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('preserves absent, null and ordinary Parent while rejecting conflicting relations', () => {
  const task = detailFixture(project, child);
  expect(parseTaskDetail(task, project, child)).not.toHaveProperty('parentTaskId');
  expect(parseTaskDetail({ ...task, parentTaskId: null }, project, child)).toHaveProperty('parentTaskId', null);
  expect(parseTaskDetail({ ...task, parentTaskId: parent.toUpperCase() }, project, child)).toHaveProperty('parentTaskId', parent);
  expect(() => parseTaskDetail({ ...task, parentId: other, parentTaskId: parent }, project, child)).toThrow();
  expect(() => parseTaskDetail({ ...task, type: 'goal', parentTaskId: parent }, project, child)).toThrow();
  expect(() => parseTaskDetail({ ...task, parentTaskId: undefined }, project, child)).toThrow();
});

it('requests the relation projection and retains old service omission', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(detailFixture(project, child))); vi.stubGlobal('fetch', fetcher);
  expect(await getTask(project, child, signal(), admission)).not.toHaveProperty('parentTaskId');
  expect(fetcher.mock.calls[0]![1].headers['Daynight-Task-Relations']).toBe('task-parent-v1');
});

it('creates an ordinary child once and requires the committed receipt to match its Parent', async () => {
  const saved = detailFixture(project, child, { title: 'Child', status: 'proposed', ready: false, parentTaskId: parent });
  const fetcher = vi.fn().mockResolvedValueOnce(response(saved, 201)).mockResolvedValueOnce(response({ ...saved, parentTaskId: null }, 201)); vi.stubGlobal('fetch', fetcher);
  await expect(createTask(project, { title: 'Child', parentTaskId: parent.toUpperCase() }, signal(), admission)).resolves.toMatchObject({ id: child, parentTaskId: parent });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ title: 'Child', parentTaskId: parent, tagIds: [] });
  await expect(createTask(project, { title: 'Child', parentTaskId: parent }, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  expect(admission.onWriteConfirmed).toHaveBeenCalledTimes(2);
  await expect(createTask(project, { title: 'Child', parentId: other, parentTaskId: parent }, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('reads all statuses using a scoped paged direct-child GET and exact versions', async () => {
  const saved = detailFixture(project, child, { parentTaskId: parent, status: 'done', ready: false, completedAt: '2026-10-22T10:00:00Z', version: 9007199254740993n });
  const fetcher = vi.fn().mockResolvedValueOnce(response({ items: [saved], nextCursor: 'next' })).mockResolvedValueOnce(response({ items: [], nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  await expect(listTaskChildren(project, parent, null, signal(), admission)).resolves.toMatchObject({ items: [{ id: child, parentTaskId: parent, version: 9007199254740993n }], nextCursor: 'next' });
  await expect(listTaskChildren(project, parent, 'next', signal(), admission)).resolves.toEqual({ items: [], nextCursor: null });
  const firstUrl = new URL(fetcher.mock.calls[0]![0], 'https://example.test');
  expect(firstUrl.searchParams.get('parentTaskId')).toBe(parent);
  expect(firstUrl.searchParams.has('status')).toBe(false);
  expect(new URL(fetcher.mock.calls[1]![0], 'https://example.test').searchParams.get('cursor')).toBe('next');
  for (const bad of [{ ...saved, parentTaskId: other }, { ...saved, parentTaskId: undefined }, { ...saved, projectId: other }]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [bad], nextCursor: null })));
    await expect(listTaskChildren(project, parent, null, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  }
});

it('validates search Parent context and restricts an ordinary Parent filter', async () => {
  const filters = { status: '' as const, assignedTo: '', type: 'task' as const, parentId: null, parentTaskId: parent, tagIds: [], tagMatch: 'all' as const, untagged: false };
  const item = { id: child, type: 'task', parentId: null, parentTaskId: parent, parentTaskContext: { taskId: parent, title: 'Parent' }, projectId: project, title: 'Child', status: 'todo', assignedTo: null, updatedAt: '2026-10-22T10:00:00Z', cancelledAt: null, tags: [], context: null, match: { fields: ['title'], descriptionSnippet: null } };
  const fetcher = vi.fn().mockResolvedValueOnce(response({ projectId: project, total: 1, items: [item], nextCursor: null })).mockResolvedValueOnce(response({ projectId: project, total: 1, items: [{ ...item, parentTaskContext: { taskId: other, title: 'Wrong' } }], nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  await expect(searchTasks(project, 'Child', filters, null, signal(), admission)).resolves.toMatchObject({ items: [{ id: child, parentTaskContext: { taskId: parent } }] });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).parentTaskId).toBe(parent);
  await expect(searchTasks(project, 'Child', filters, null, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
});
