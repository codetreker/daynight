import { TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTask, setTaskRequiredPlatform } from '../src/api/client';
import { stringifyApiJson } from '../src/api/json';
import { parseTaskDetail, parseTaskGraph } from '../src/api/parse';
import type { ExecutionPlatform } from '../src/api/types';

const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:00:00Z';
const task = { id: taskId, projectId, title: 'Platform work', description: '', properties: { pullRequests: [] }, status: 'todo',
  version: 9007199254740993n, allowAgents: false, requiredPlatform: null, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const graph = (requiredPlatform: unknown) => ({ observedAt: time,
  project: { id: projectId, name: 'Project', repoUrl: 'https://example.com/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
  summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 },
  tasks: [{ ...task, titlePreview: task.title, titleTruncated: false, requiredPlatform }],
});
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
afterEach(() => vi.unstubAllGlobals());

describe('strict execution platform contract', () => {
  it.each([null, 'windows', 'linux', 'macos'])('preserves the explicit platform %s in full task and graph resources', (requiredPlatform) => {
    expect(parseTaskDetail({ ...task, requiredPlatform }, projectId, taskId)).toMatchObject({ requiredPlatform, ready: true, allowAgents: false });
    expect(parseTaskGraph(graph(requiredPlatform), projectId).tasks[0]).toMatchObject({ requiredPlatform, ready: true });
  });
  it.each([undefined, '', 'darwin', 'win32', 'LINUX', false, 0, {}, []])('rejects missing or malformed platform %#', async (requiredPlatform) => {
    expect(() => parseTaskDetail({ ...task, requiredPlatform }, projectId, taskId)).toThrow('invalid response');
    expect(() => parseTaskGraph(graph(requiredPlatform), projectId)).toThrow('invalid response');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...task, requiredPlatform })));
    await expect(getTask(projectId, taskId, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it.each([null, 'windows', 'linux', 'macos'] as const)('submits one exact-version platform PATCH for %s', async (requiredPlatform) => {
    const result = { ...task, requiredPlatform, version: task.version + 1n };
    const fetcher = vi.fn().mockResolvedValue(response(result)); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskRequiredPlatform(projectId, taskId, requiredPlatform, task.version, signal(), admission)).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}`, expect.objectContaining({
      method: 'PATCH', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      body: `{"version":9007199254740993,"requiredPlatform":${JSON.stringify(requiredPlatform)}}`,
    }));
  });
  it('accepts an exact-version no-op and preserves server conflicts without retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(task)).mockResolvedValueOnce(response({ error: { code: 'version_conflict', message: 'Changed', requestId: 'conflict' } }, 409));
    vi.stubGlobal('fetch', fetcher);
    await expect(setTaskRequiredPlatform(projectId, taskId, null, task.version, signal(), admission)).resolves.toEqual(task);
    await expect(setTaskRequiredPlatform(projectId, taskId, 'linux', task.version, signal(), admission)).rejects.toMatchObject({ kind: 'server', code: 'version_conflict' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ requiredPlatform: 'windows', version: task.version + 1n }, { requiredPlatform: 'linux', version: task.version - 1n },
    { requiredPlatform: 'linux', version: task.version + 2n }, { requiredPlatform: 'linux', id: projectId, version: task.version + 1n }])('rejects a contradictory result %#', async (fields) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...task, ...fields })));
    await expect(setTaskRequiredPlatform(projectId, taskId, 'linux', task.version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('rejects non-200 results, invalid inputs and cancelled requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ...task, requiredPlatform: 'linux', version: task.version + 1n }, 201)); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskRequiredPlatform(projectId, taskId, 'linux', task.version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol', status: 201 });
    for (const value of [undefined, 'darwin', '', false, {}]) await expect(setTaskRequiredPlatform(projectId, taskId, value as ExecutionPlatform, task.version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(setTaskRequiredPlatform(projectId, taskId, 'linux', 0n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    const controller = new AbortController(); controller.abort();
    await expect(setTaskRequiredPlatform(projectId, taskId, null, task.version, controller.signal, admission)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
