import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsupportedSessionObservation } from '../../daynight/src/api/task-observation';
import { listPersonalTasks, parsePersonalTaskPage } from '../src/api/personal-tasks';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const item = () => ({ project: { id: workerId(3), name: 'Project', ownerTeam: { id: workerId(4), kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 1 }, task: { id: workerId(5), version: '9007199254740993', title: 'Task', status: 'in_progress', startedAt: null, allowAgents: true, paused: false, worker: null, goal: null }, session: unsupportedSessionObservation() });
const page = () => ({ observedAt: WORKER_TIME, inventoryRevision: 'a'.repeat(64), totalTaskCount: 1, totalProjectCount: 1, sessionPartial: true, items: [item()], nextCursor: null });
afterEach(() => vi.unstubAllGlobals());
describe('personal task response', () => {
  it('preserves exact version and complete session', () => {
    const parsed = parsePersonalTaskPage(page());
    expect(parsed.items[0]?.task.version).toBe('9007199254740993');
    expect(parsed.items[0]?.session).toEqual(unsupportedSessionObservation());
  });
  it('requires an exact nullable Worker summary with valid IDs and Unicode name', () => {
    const value = page(), row = item();
    const worker = { workerId: workerId(6), machine: { id: workerId(7), name: '机器 <worker> 🖥️' } };
    const withWorker = (candidate: unknown) => ({ ...value, items: [{ ...row, task: { ...row.task, worker: candidate } }] });
    expect(parsePersonalTaskPage(withWorker(worker)).items[0]?.task.worker).toEqual(worker);
    expect(parsePersonalTaskPage(value).items[0]?.task.worker).toBeNull();
    const { worker: _worker, ...withoutWorker } = row.task;
    for (const invalid of [
      { ...value, items: [{ ...row, task: withoutWorker }] },
      withWorker(undefined), withWorker('worker'), withWorker({ ...worker, extra: true }),
      withWorker({ ...worker, workerId: 'bad' }), withWorker({ ...worker, machine: null }),
      withWorker({ ...worker, machine: { ...worker.machine, extra: true } }),
      withWorker({ ...worker, machine: { ...worker.machine, id: 'bad' } }),
      withWorker({ ...worker, machine: { ...worker.machine, name: '' } }),
      withWorker({ ...worker, machine: { ...worker.machine, name: '\ud800' } }),
      withWorker({ ...worker, machine: { ...worker.machine, name: 7 } }),
    ]) expect(() => parsePersonalTaskPage(invalid)).toThrow();
  });
  it('rejects missing fields, unknown fields, malformed values and conflicting team name', () => {
    const value = page(), row = item();
    for (const invalid of [
      { ...value, inventoryRevision: 'bad' }, { ...value, extra: true }, { ...value, totalTaskCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...value, observedAt: '2026-02-31T00:00:00Z' }, { ...value, items: [{ ...row, session: null }] },
      { ...value, items: [{ ...row, task: { ...row.task, version: 12 } }] },
      { ...value, items: [{ ...row, task: { ...row.task, version: '9223372036854775808' } }] },
      { ...value, items: [{ ...row, project: { ...row.project, ownerTeam: { ...row.project.ownerTeam, kind: 'personal' } } }] },
    ]) expect(() => parsePersonalTaskPage(invalid)).toThrow();
  });
  it('accepts a long server cursor containing escaped project and Team names', () => {
    const escaped = '\\u003c'.repeat(256);
    const cursor = btoa(`{"projectName":"${escaped}","teamName":"${escaped}"}`).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    expect(cursor.length).toBeGreaterThan(4096);
    expect(parsePersonalTaskPage({ ...page(), nextCursor: cursor }).nextCursor).toBe(cursor);
    expect(() => parsePersonalTaskPage({ ...page(), nextCursor: 'a'.repeat(16_385) })).toThrow();
  });
  it('binds requests to the principal and encodes the cursor', async () => {
    const fetch = vi.fn().mockResolvedValue(wireResponse(page(), { headers: { 'Daynight-User-ID': WORKER_USER } }));
    vi.stubGlobal('fetch', fetch);
    expect(await listPersonalTasks('next/+', new AbortController().signal, { userId: WORKER_USER, onPrincipalMismatch: vi.fn() })).toEqual(parsePersonalTaskPage(page()));
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/me/in-progress-tasks?limit=100&cursor=next%2F%2B');
    const mismatch = vi.fn(); fetch.mockResolvedValueOnce(wireResponse(page(), { headers: { 'Daynight-User-ID': workerId(99) } }));
    await expect(listPersonalTasks(null, new AbortController().signal, { userId: WORKER_USER, onPrincipalMismatch: mismatch })).rejects.toThrow();
    expect(mismatch).toHaveBeenCalledOnce();
  });
});
