import { afterEach, describe, expect, it, vi } from 'vitest';
import { unpauseTask } from '../src/api/client';
import { stringifyApiJson } from '../src/api/json';
import { parseTaskDetail } from '../src/api/parse';
import { readTaskPaused } from '../src/api/task-properties';
import { parseTaskSummary } from '../src/api/task-sync';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const version = 9_007_199_254_740_993n;
const initial = detailFixture(project, taskId, { version, properties: { paused: true, pullRequests: [] } });
const changed = { ...initial, version: version + 1n, properties: { ...initial.properties, paused: false } };
const summary = { ...initial, version: version.toString(), titlePreview: initial.title, titleTruncated: false };
const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200, principal = TEST_VIEWER_ID) => new Response(stringifyApiJson(value), { status, headers: viewerHeaders(principal, { 'Content-Type': 'application/json' }) });
afterEach(() => vi.unstubAllGlobals());

describe('task pause contract', () => {
  it.each([{}, { paused: true }, { paused: false }])('preserves absence and explicit booleans in detail and synchronized summaries: %j', (properties) => {
    expect(parseTaskDetail({ ...initial, properties }, project, taskId).properties).toEqual(properties);
    expect(parseTaskSummary({ ...summary, properties }).properties).toEqual(properties);
    expect(readTaskPaused(properties)).toBe(Object.hasOwn(properties, 'paused') ? properties.paused : undefined);
  });
  it.each([null, 'true', 'false', 0, 1, [], {}])('rejects a malformed present pause in details and synchronization: %j', (paused) => {
    expect(() => parseTaskDetail({ ...initial, properties: { paused } }, project, taskId)).toThrow('invalid response');
    expect(() => parseTaskSummary({ ...summary, properties: { paused } })).toThrow('invalid response');
  });
  it('submits one property-only PATCH with the complete exact version', async () => {
    const confirmed = vi.fn(); const fetcher = vi.fn().mockResolvedValue(response(changed)); vi.stubGlobal('fetch', fetcher);
    await expect(unpauseTask(project, taskId, version, signal(), { ...admission, onWriteConfirmed: confirmed })).resolves.toEqual(changed);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tasks/${taskId}`, expect.objectContaining({
      method: 'PATCH', credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: '{"version":9007199254740993,"properties":{"paused":false}}',
    }));
    expect(confirmed).toHaveBeenCalledOnce();
  });
  it('accepts an exact-version no-op and retains a version conflict without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ...changed, version })).mockResolvedValueOnce(response({ error: { code: 'version_conflict', message: 'Changed', requestId: 'pause-conflict' } }, 409));
    vi.stubGlobal('fetch', fetcher);
    await expect(unpauseTask(project, taskId, version, signal(), admission)).resolves.toMatchObject({ version });
    await expect(unpauseTask(project, taskId, version, signal(), admission)).rejects.toMatchObject({ kind: 'server', code: 'version_conflict' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { properties: { paused: true } }, { properties: {} }, { version: version - 1n }, { version: version + 2n }, { id: project },
  ])('rejects a response that does not prove the requested unpause %#', async (fields) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...changed, ...fields })));
    await expect(unpauseTask(project, taskId, version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('rejects a different principal before decoding or confirming the write', async () => {
    const body = response(changed, 200, taskId); const text = vi.spyOn(body, 'text'); const confirmed = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body));
    await expect(unpauseTask(project, taskId, version, signal(), { ...admission, onWriteConfirmed: confirmed })).rejects.toMatchObject({ kind: 'protocol' });
    expect(text).not.toHaveBeenCalled(); expect(confirmed).not.toHaveBeenCalled();
  });
  it('rejects non-200 responses, invalid versions and cancelled requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(changed, 201)); vi.stubGlobal('fetch', fetcher);
    await expect(unpauseTask(project, taskId, version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol', status: 201 });
    await expect(unpauseTask(project, taskId, 0n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    const controller = new AbortController(); controller.abort();
    await expect(unpauseTask(project, taskId, version, controller.signal, admission)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
