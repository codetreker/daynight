import { afterEach, describe, expect, it, vi } from 'vitest';
import { withdrawWorkerClaim } from '../src/api/client';
import { stringifyApiJson } from '../src/api/json';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const projectId = '10000000-0000-4000-8000-00000000000a';
const taskId = '20000000-0000-4000-8000-00000000000b';
const claimId = '30000000-0000-4000-8000-00000000000c';
const otherId = '40000000-0000-4000-8000-00000000000d';
const time = '2026-10-24T00:00:00Z';
const version = 9_007_199_254_740_993n;
const result: TaskDetail = {
  id: taskId, projectId, title: 'Claimed task', description: 'Keep its delivery materials.',
  properties: { worker: null, pullRequests: [{ title: 'Implementation', url: 'https://example.com/pull/42' }] },
  status: 'todo', version: version + 1n, requiredPlatform: 'macos', allowAgents: false, ready: true,
  dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time,
};
const worker: WorkerClaim = {
  claimId, state: 'released', userId: TEST_VIEWER_ID, workerId: otherId, machine: { id: otherId, name: 'Machine' },
  platform: 'macos', agent: 'codex', agentControlMode: 'herdr', worktreeId: projectId, phase: 'paused', herdr: null, nativeSessionId: null, claimedAt: time,
};
const signal = () => new AbortController().signal;
const response = (value: unknown, status = 200, principal = TEST_VIEWER_ID) => new Response(stringifyApiJson(value), {
  status, headers: viewerHeaders(principal, { 'Content-Type': 'application/json' }),
});
const admission = () => ({ userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

describe('worker claim withdrawal transport', () => {
  it('sends one scoped POST with the reviewed claim and exact numeric version', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal('fetch', fetcher);
    const abortSignal = signal();
    const receipt = admission();
    await expect(withdrawWorkerClaim(projectId.toUpperCase(), taskId.toUpperCase(), claimId.toUpperCase(), version, abortSignal, receipt)).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/tasks/${taskId}/worker-claim/withdraw`, {
      method: 'POST', redirect: 'error', signal: abortSignal, cache: 'no-store', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Daynight-Worker-Protocol': '2' },
      body: `{"version":9007199254740993,"claimId":"${claimId}"}`,
    });
    expect(receipt.onWriteConfirmed).toHaveBeenCalledOnce();
  });

  it.each([
    { version }, { version: version + 2n }, { id: otherId }, { projectId: otherId },
    { properties: { ...result.properties, worker } }, { allowAgents: true },
    { status: 'in_progress', ready: false }, { startedAt: time }, { completedAt: time },
  ])('rejects a response that does not prove the reset %#', async (changed) => {
    const fetcher = vi.fn().mockResolvedValue(response({ ...result, ...changed }));
    vi.stubGlobal('fetch', fetcher);
    await expect(withdrawWorkerClaim(projectId, taskId, claimId, version, signal(), admission())).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects another principal before reading or admitting the response body', async () => {
    const reply = response(result, 200, otherId);
    const readBody = vi.spyOn(reply, 'text');
    const receipt = admission();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply));
    await expect(withdrawWorkerClaim(projectId, taskId, claimId, version, signal(), receipt)).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
    expect(receipt.onPrincipalMismatch).toHaveBeenCalledOnce();
    expect(receipt.onWriteConfirmed).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'claim_conflict', 'version_conflict'])('preserves %s without retrying the write', async (code) => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: { code, message: 'Refused', requestId: 'withdrawal-refusal' } }, code === 'forbidden' ? 403 : 409));
    vi.stubGlobal('fetch', fetcher);
    const receipt = admission();
    await expect(withdrawWorkerClaim(projectId, taskId, claimId, version, signal(), receipt)).rejects.toMatchObject({ kind: 'server', code, requestId: 'withdrawal-refusal' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(receipt.onWriteConfirmed).not.toHaveBeenCalled();
  });

  it('keeps lost-response errors visible without replaying and rejects unexpected success status', async () => {
    const cause = new TypeError('Connection lost');
    const fetcher = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(response(result, 201));
    vi.stubGlobal('fetch', fetcher);
    await expect(withdrawWorkerClaim(projectId, taskId, claimId, version, signal(), admission())).rejects.toMatchObject({ kind: 'network', cause });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(withdrawWorkerClaim(projectId, taskId, claimId, version, signal(), admission())).rejects.toMatchObject({ kind: 'protocol', status: 201 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('validates identities, version and cancellation before network effects', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const [project, task, claim] of [['bad', taskId, claimId], [projectId, 'bad', claimId], [projectId, taskId, 'bad']]) {
      await expect(withdrawWorkerClaim(project!, task!, claim!, version, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    }
    for (const invalid of [0n, -1n, 9_223_372_036_854_775_808n, 1 as unknown as bigint]) {
      await expect(withdrawWorkerClaim(projectId, taskId, claimId, invalid, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    }
    const controller = new AbortController();
    const reason = new Error('Project closed');
    controller.abort(reason);
    await expect(withdrawWorkerClaim(projectId, taskId, claimId, version, controller.signal, admission())).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
