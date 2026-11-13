import { afterEach, expect, it, vi } from 'vitest';
import { createTask, updateTaskFields } from '../src/api/client';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const goal = '30000000-0000-4000-8000-000000000001';
const signal = () => new AbortController().signal;
const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed: vi.fn() };
const response = (body: unknown, status: number) => wireResponse(body, { status, headers: viewerHeaders(TEST_VIEWER_ID) });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('creates Goals and Tasks with explicit nullable and omitted fields intact', async () => {
  const goalDetail = detailFixture(project, goal, { type: 'goal', title: 'Release', status: 'todo', ready: false, assignedTo: null });
  const child = detailFixture(project, task, { title: 'Child', status: 'proposed', parentId: goal });
  const fetcher = vi.fn().mockResolvedValueOnce(response(goalDetail, 201)).mockResolvedValueOnce(response(child, 201)); vi.stubGlobal('fetch', fetcher);
  await expect(createTask(project, { type: 'goal', title: 'Release', assignedTo: null }, signal(), admission)).resolves.toMatchObject({ id: goal, type: 'goal' });
  await expect(createTask(project, { title: 'Child', parentId: goal }, signal(), admission)).resolves.toMatchObject({ id: task, parentId: goal });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ type: 'goal', title: 'Release', assignedTo: null });
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ title: 'Child', parentId: goal });
  expect(admission.onWriteConfirmed).toHaveBeenCalledTimes(2);
});

it('sends exact versions and nullable Parent, preserving unrelated fields', async () => {
  const saved = detailFixture(project, task, { parentId: null, version: 9007199254740994n });
  const fetcher = vi.fn().mockResolvedValue(response(saved, 200)); vi.stubGlobal('fetch', fetcher);
  await expect(updateTaskFields(project, task, { parentId: null }, 9007199254740993n, signal(), admission)).resolves.toMatchObject({ parentId: null });
  expect(fetcher.mock.calls[0]![1].body).toBe('{"version":9007199254740993,"parentId":null}');
});

it('reports a confirmed receipt even when a successful response body is invalid', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ id: task }, 201)));
  await expect(createTask(project, { title: 'Child' }, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  expect(admission.onWriteConfirmed).toHaveBeenCalledOnce();
});

it('PATCHes the complete tag set including an explicit empty set and qualifies receipts', async () => {
  const tag = '40000000-0000-4000-8000-000000000001';
  const saved = detailFixture(project, task, { version: 9007199254740994n, tags: [{ id: tag, name: 'Tag' }] });
  const empty = detailFixture(project, task, { version: 9007199254740995n, tags: [] });
  const fetcher = vi.fn().mockResolvedValueOnce(response(saved, 200)).mockResolvedValueOnce(response(empty, 200)).mockResolvedValueOnce(response(empty, 200)); vi.stubGlobal('fetch', fetcher);
  await expect(updateTaskFields(project, task, { tagIds: [tag] }, 9007199254740993n, signal(), admission)).resolves.toMatchObject({ tags: [{ id: tag }] });
  await expect(updateTaskFields(project, task, { tagIds: [] }, 9007199254740994n, signal(), admission)).resolves.toMatchObject({ tags: [] });
  expect(fetcher.mock.calls[0]![1].body).toBe(`{"version":9007199254740993,"tagIds":["${tag}"]}`);
  expect(fetcher.mock.calls[1]![1].body).toBe('{"version":9007199254740994,"tagIds":[]}');
  await expect(updateTaskFields(project, task, { tagIds: [tag] }, 9007199254740994n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  await expect(updateTaskFields(project, task, { tagIds: [tag, tag] }, 9007199254740994n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
