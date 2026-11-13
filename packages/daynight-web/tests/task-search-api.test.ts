import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { searchSelectionRange, searchTasks, TaskSearchError } from '../src/api/task-search';

const project = '79ccb68f-2bb1-4f41-a364-8befabb50945';
const user = '459052e2-186f-4a52-8a58-55425ce43631';
const admission = { userId: user, onPrincipalMismatch: vi.fn() };
const filters = { status: '' as const, assignedTo: '' };
const fixture = (name: string) => {
  const body = readFileSync(`../daynight-server/testdata/task-search/${name}.json`, 'utf8');
  // These captured search examples predate the required tag projection.
  if (!['first-page', 'id-only', 'mixed-fields'].includes(name)) return body;
  const page = JSON.parse(body);
  return JSON.stringify({ ...page, items: page.items.map((item: object) => ({ ...item, tags: [] })) });
};
const response = (body: string, status = 200, principal = user) => new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const read = (query = 'cache') => searchTasks(project, query, filters, null, new AbortController().signal, admission);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('reads the HTTP fixture with current tag references and sends a scoped POST without ranking or projection', async () => {
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
it('rejects non-object success and error bodies without scanning them as JSON objects', async () => {
  for (const body of ['[0]', '[]', 'null', 'true', '0', '"text"']) {
    for (const status of [200, 400]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body, status)));
      await expect(read()).rejects.toMatchObject({ kind: 'protocol' });
    }
  }
  for (const body of [
    '{"error":[0]}',
    '{"error":{"code":"invalid_search_expression","message":"bad","requestId":"request","details":[0]}}',
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body, 400)));
    await expect(read()).rejects.toMatchObject({ kind: 'protocol' });
  }
});

it('sends an exact proposed filter and preserves proposed search results', async () => {
  const body = JSON.parse(fixture('first-page'));
  const proposed = { ...body, items: [{ ...body.items[0], status: 'proposed', cancelledAt: null }] };
  const fetcher = vi.fn().mockResolvedValue(response(JSON.stringify(proposed))); vi.stubGlobal('fetch', fetcher);
  await expect(searchTasks(project, 'cache', { status: 'proposed', assignedTo: '' }, null, new AbortController().signal, admission))
    .resolves.toMatchObject({ items: [{ status: 'proposed', cancelledAt: null }] });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ query: 'cache', status: 'proposed', limit: 15 });
});

it('requires cancellation time on search items and retains cancelled results', async () => {
  const body = JSON.parse(fixture('first-page'));
  const cancelled = { ...body, items: [{ ...body.items[0], status: 'cancelled', cancelledAt: '2026-11-06T00:00:00Z' }] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(JSON.stringify(cancelled))));
  await expect(searchTasks(project, 'cancelled', { status: 'cancelled', assignedTo: '' }, null, new AbortController().signal, admission)).resolves.toMatchObject({ items: [{ status: 'cancelled', cancelledAt: '2026-11-06T00:00:00Z' }] });
  for (const change of [{ cancelledAt: undefined }, { cancelledAt: null }, { status: 'done' }]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(JSON.stringify({ ...cancelled, items: [{ ...cancelled.items[0], ...change }] }))));
    await expect(read('cancelled')).rejects.toMatchObject({ kind: 'protocol' });
  }
});

it('accepts all ordered field subsequences and preserves the raw ID expression', async () => {
  const original = JSON.parse(fixture('first-page'));
  const cases = [[], ['id'], ['title'], ['description'], ['id', 'title'], ['id', 'description'], ['title', 'description'], ['id', 'title', 'description']];
  for (const fields of cases) {
    const match = { fields, descriptionSnippet: fields.includes('description') ? '摘录😀' : null };
    const page = { ...original, total: 1, items: [{ ...original.items[0], match }], nextCursor: null };
    const fetch = vi.fn().mockResolvedValue(response(JSON.stringify(page))); vi.stubGlobal('fetch', fetch);
    const query = '  id:"50E2-4aaf" OR title:cache  ';
    expect((await read(query)).items[0]?.match).toEqual(match);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).query).toBe(query);
  }
});
it('rejects malformed ID search evidence', async () => {
  const original = JSON.parse(fixture('first-page'));
  for (const match of [
    { fields: ['unknown'], descriptionSnippet: null }, { fields: ['id', 'id'], descriptionSnippet: null },
    { fields: ['title', 'id'], descriptionSnippet: null }, { fields: ['description', 'id'], descriptionSnippet: 'x' },
    { fields: ['id'], descriptionSnippet: 'x' }, { fields: ['description'], descriptionSnippet: '' },
    { fields: ['description'], descriptionSnippet: '😀'.repeat(163) }, { fields: ['id'] },
    { descriptionSnippet: null }, { fields: ['description'], descriptionSnippet: '\ud800' },
  ]) {
    const page = { ...original, total: 1, items: [{ ...original.items[0], match }], nextCursor: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(JSON.stringify(page))));
    await expect(read('id:abc')).rejects.toMatchObject({ kind: 'protocol' });
  }
});

it.each(['id-only', 'mixed-fields'])('consumes captured %s evidence without reordering', async name => {
  const body = fixture(name), page = JSON.parse(body), query = `id:${page.items[0].id}`;
  const fetch = vi.fn().mockResolvedValue(response(body)); vi.stubGlobal('fetch', fetch);
  const result = await searchTasks(page.projectId, query, filters, null, new AbortController().signal, admission);
  expect(result.items[0]?.match).toEqual(page.items[0].match);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).query).toBe(query);
});
