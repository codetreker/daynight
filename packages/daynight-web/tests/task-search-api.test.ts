import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { searchSelectionRange, searchTasks, TaskSearchError } from '../src/api/task-search';

const project = '79ccb68f-2bb1-4f41-a364-8befabb50945';
const user = '459052e2-186f-4a52-8a58-55425ce43631';
const admission = { userId: user, onPrincipalMismatch: vi.fn() };
const filters = { status: '' as const, assignedTo: '' };
const fixture = (name: string) => readFileSync(`../daynight-server/testdata/task-search/${name}.json`, 'utf8');
const response = (body: string, status = 200, principal = user) => new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const read = (query = 'cache') => searchTasks(project, query, filters, null, new AbortController().signal, admission);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('reads the real HTTP fixture and sends a scoped POST without ranking or projection', async () => {
  const fetch = vi.fn().mockResolvedValue(response(fixture('first-page'))); vi.stubGlobal('fetch', fetch);
  const page = await read(); expect(page.items[0]?.context?.title).toBe('Goal'); expect(page.total).toBe(2);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ query: 'cache', limit: 15 });
});
it('validates wire identities, fields, cursor, principal and requested filters', async () => {
  const body = JSON.parse(fixture('first-page'));
  for (const bad of [ { ...body, projectId: user }, { ...body, items: [body.items[0], body.items[0]] }, { ...body, nextCursor: '' }, { ...body, total: 0 }, { ...body, items: [{ ...body.items[0], match: { fields: ['description'], descriptionSnippet: null } }] } ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(JSON.stringify(bad))));
    await expect(read()).rejects.toMatchObject({ kind: 'protocol' });
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture('first-page'), 200, project)));
  await expect(read()).rejects.toMatchObject({ code: 'principal_mismatch' }); expect(admission.onPrincipalMismatch).toHaveBeenCalled();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture('first-page'))));
  await expect(searchTasks(project, 'cache', { status: 'done', assignedTo: '' }, null, new AbortController().signal, admission)).rejects.toMatchObject({ kind: 'protocol' });
});
it('exposes typed syntax and context errors, enforcing positions, status and JSON integer form', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture('invalid-expression'), 400)));
  const error = await read('中文abcde(').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TaskSearchError); if (!(error instanceof TaskSearchError)) throw error; expect(error.syntax).toEqual({ reason: 'unclosed_group', position: 8, length: 1 });
  expect(searchSelectionRange('😀abc(', { reason: 'unclosed_group', position: 5, length: 1 })).toEqual({ start: 5, end: 6 });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture('context-limit'), 400)));
  await expect(read()).rejects.toMatchObject({ contextLimit: { nodeCount: 20001, maxNodes: 20000 } });
  for (const bad of [fixture('invalid-expression').replace('"position":8', '"position":8.0'), fixture('invalid-expression').replace('"position":8', '"position":99')]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(bad, 400))); await expect(read('中文abcde(')).rejects.toMatchObject({ kind: 'protocol' });
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(fixture('search-changed'), 400)));
  await expect(read()).rejects.toMatchObject({ kind: 'protocol' });
});
it('correlates the response request ID without exposing the query in the URL', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(fixture('empty-page'), { status: 200, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': user, 'X-Request-ID': 'observed-id' } }));
  vi.stubGlobal('fetch', fetch); const onResponseId = vi.fn();
  await searchTasks(project, 'private query', filters, null, new AbortController().signal, admission, { requestId: 'cycle-id', onResponseId });
  expect(fetch.mock.calls[0]![0]).not.toContain('private'); expect(fetch.mock.calls[0]![1].headers['X-Request-ID']).toBe('cycle-id'); expect(onResponseId).toHaveBeenCalledWith('observed-id');
});
