import { TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTask, setTaskAgentPermission } from '../src/api/client';
import { stringifyApiJson } from '../src/api/json';
import { parseTaskDetail, parseTaskGraph } from '../src/api/parse';

const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:00:00Z';
const task = { id: taskId, projectId, title: 'Automatic work', description: '', properties: { worker: null, pullRequests: [] }, status: 'todo',
  version: 9007199254740993n, requiredPlatform: null, allowAgents: false, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const graph = (allowAgents: unknown) => ({ observedAt: time,
  project: { id: projectId, name: 'Project', repoUrl: 'https://example.com/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
  summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 },
  tasks: [{ ...task, titlePreview: task.title, titleTruncated: false, allowAgents }],
});
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
afterEach(() => vi.unstubAllGlobals());

describe('strict task automatic execution contract', () => {
  it.each([false, true])('preserves explicit %s in task and graph resources without changing ready', (allowAgents) => {
    expect(parseTaskDetail({ ...task, allowAgents }, projectId, taskId)).toMatchObject({ allowAgents, ready: true });
    expect(parseTaskGraph(graph(allowAgents), projectId).tasks[0]).toMatchObject({ allowAgents, ready: true });
  });
  it.each([undefined, null, 'false', 'true', 0, 1, {}, []])('rejects invalid or missing permission %#', async (allowAgents) => {
    expect(() => parseTaskDetail({ ...task, allowAgents }, projectId, taskId)).toThrow('invalid response');
    expect(() => parseTaskGraph(graph(allowAgents), projectId)).toThrow('invalid response');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...task, allowAgents })));
    await expect(getTask(projectId, taskId, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it.each([false, true])('sends one exact numeric-wire PATCH for %s', async (allowAgents) => {
    const updated = { ...task, version: task.version + 1n, allowAgents };
    const fetcher = vi.fn().mockResolvedValue(response(updated));
    vi.stubGlobal('fetch', fetcher);
    await expect(setTaskAgentPermission(projectId, taskId, allowAgents, task.version, signal(), admission)).resolves.toEqual(updated);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}`, expect.objectContaining({
      method: 'PATCH', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      body: `{"version":9007199254740993,"allowAgents":${allowAgents}}`,
    }));
  });
  it('accepts an exact-version same-value no-op response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(task)));
    await expect(setTaskAgentPermission(projectId, taskId, false, task.version, signal(), admission)).resolves.toEqual(task);
  });
  it.each([
    { allowAgents: false, version: task.version + 1n },
    { allowAgents: true, version: task.version - 1n },
    { allowAgents: true, version: task.version + 2n },
    { allowAgents: true, version: task.version + 1n, id: projectId },
  ])('rejects a response that cannot confirm the requested update %#', async (fields) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...task, ...fields })));
    await expect(setTaskAgentPermission(projectId, taskId, true, task.version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('rejects a non-200 success status and preserves the server conflict without retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ...task, allowAgents: true, version: task.version + 1n }, 201))
      .mockResolvedValueOnce(response({ error: { code: 'version_conflict', message: 'Changed', requestId: 'conflict' } }, 409));
    vi.stubGlobal('fetch', fetcher);
    await expect(setTaskAgentPermission(projectId, taskId, true, task.version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol', status: 201 });
    await expect(setTaskAgentPermission(projectId, taskId, true, task.version, signal(), admission)).rejects.toMatchObject({ kind: 'server', code: 'version_conflict' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('validates input before network effects and respects cancellation', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskAgentPermission(projectId, taskId, 'true' as unknown as boolean, task.version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(setTaskAgentPermission(projectId, taskId, true, 0n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    const controller = new AbortController(); controller.abort();
    await expect(setTaskAgentPermission(projectId, taskId, true, task.version, controller.signal, admission)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
