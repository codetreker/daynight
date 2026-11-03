import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTaskAssignedTo } from '../src/api/client';
import { stringifyApiJson } from '../src/api/json';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const person = '30000000-0000-4000-8000-000000000001';
const initial = detailFixture(project, task, { version: 9007199254740993n, assignedTo: null, allowAgents: true });
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200, viewer = TEST_VIEWER_ID) => new Response(stringifyApiJson(value), { status, headers: viewerHeaders(viewer, { 'Content-Type': 'application/json' }) });
const admission = () => ({ userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

describe('assignment PATCH contract', () => {
  it.each([null, person])('sends an explicit assignment %s with its lossless exact version', async (assignedTo) => {
    const saved = { ...initial, assignedTo, version: initial.version + 1n, allowAgents: false };
    const fetcher = vi.fn().mockResolvedValue(response(saved)); vi.stubGlobal('fetch', fetcher);
    const admitted = admission();
    await expect(setTaskAssignedTo(project, task, assignedTo, initial.version, signal(), admitted)).resolves.toEqual(saved);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tasks/${task}`, expect.objectContaining({
      method: 'PATCH', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      body: `{"version":9007199254740993,"assignedTo":${JSON.stringify(assignedTo)}}`,
    }));
    expect(admitted.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it('accepts a server no-op without changing its complete resource', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(initial)); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskAssignedTo(project, task, null, initial.version, signal(), admission())).resolves.toEqual(initial);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([undefined, '', 'not-a-uuid', false, {}, [], 0])('rejects malformed assignment %# before sending a request', async (assignedTo) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskAssignedTo(project, task, assignedTo as string, initial.version, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { assignedTo: null, version: initial.version + 1n },
    { assignedTo: person, version: initial.version - 1n },
    { assignedTo: person, version: initial.version + 2n },
    { assignedTo: person, version: initial.version + 1n, id: project },
  ])('rejects a contradictory complete response %#', async (fields) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...initial, ...fields })));
    const admitted = admission();
    await expect(setTaskAssignedTo(project, task, person, initial.version, signal(), admitted)).rejects.toMatchObject({ kind: 'protocol' });
    expect(admitted.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it('records a confirmed 200 before a malformed body is read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{', { status: 200, headers: viewerHeaders(TEST_VIEWER_ID) })));
    const admitted = admission();
    await expect(setTaskAssignedTo(project, task, person, initial.version, signal(), admitted)).rejects.toMatchObject({ kind: 'protocol' });
    expect(admitted.onWriteConfirmed).toHaveBeenCalledOnce();
  });
  it.each([201, 409, 500])('does not confirm or retry status %s', async (status) => {
    const value = status === 201 ? { ...initial, assignedTo: person, version: initial.version + 1n } : { error: { code: status === 409 ? 'version_conflict' : 'internal_error', message: 'Rejected', requestId: 'assignment-rejected' } };
    const fetcher = vi.fn().mockResolvedValue(response(value, status)); vi.stubGlobal('fetch', fetcher);
    const admitted = admission();
    await expect(setTaskAssignedTo(project, task, person, initial.version, signal(), admitted)).rejects.toMatchObject({ status });
    expect(admitted.onWriteConfirmed).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('checks the response principal before adopting or confirming a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...initial, assignedTo: person, version: initial.version + 1n }, 200, person)));
    const admitted = admission();
    await expect(setTaskAssignedTo(project, task, person, initial.version, signal(), admitted)).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
    expect(admitted.onPrincipalMismatch).toHaveBeenCalledOnce(); expect(admitted.onWriteConfirmed).not.toHaveBeenCalled();
  });
  it('rejects invalid versions and a cancelled request before dispatch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskAssignedTo(project, task, person, 0n, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    const controller = new AbortController(); controller.abort();
    await expect(setTaskAssignedTo(project, task, person, initial.version, controller.signal, admission())).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
