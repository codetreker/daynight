import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsupportedSessionObservation } from '../../daynight/src/api/task-observation';
import { listPersonalTasks, parsePersonalTaskPage } from '../src/api/personal-tasks';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const item = () => ({ project: { id: workerId(3), name: 'Project', ownerTeam: { id: workerId(4), kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 1 }, task: { id: workerId(5), version: '9007199254740993', title: 'Task', status: 'in_progress', startedAt: null, createdAt: '2026-11-13T09:00:00Z', requiredPlatform: null, tags: [], blockedBy: [], ready: false, allowAgents: true, paused: false, worker: null, goal: null }, session: unsupportedSessionObservation(), sessionRow: { taskVersion: '9007199254740993', state: 'unavailable', observedAt: null, freshUntil: null, needsAttention: null, canOpen: false } });
const page = () => ({ observedAt: WORKER_TIME, responseTaskAt: WORKER_TIME, responseSessionAt: WORKER_TIME, inventoryRevision: 'a'.repeat(64), totalTaskCount: 1, totalProjectCount: 1, sessionPartial: true, items: [item()], nextCursor: null });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('personal task response', () => {
  it('preserves exact version and complete session', () => {
    const parsed = parsePersonalTaskPage(page());
    expect(parsed.items[0]?.task.version).toBe('9007199254740993');
    expect(parsed.items[0]?.session).toEqual(unsupportedSessionObservation());
    expect(parsed.items[0]?.sessionRow).toEqual({ ...item().sessionRow, taskVersion: 9007199254740993n });
  });
  it('requires a current-version row and independently proven current execution before opening a Session', () => {
    const value = page(), row = item();
    const active = { ...row, task: { ...row.task, worker: { workerId: workerId(6), state: 'active', machine: { id: workerId(7), name: 'Machine' } } },
      session: { ...row.session, observation: 'observed' as const, registration: 'registered' as const, sessionId: workerId(8), claimId: workerId(9),
        executionGeneration: '1', connectionEpoch: '1', agentControlMode: 'web' as const, contentKind: 'native_timeline' as const,
        observedAt: WORKER_TIME, freshUntil: '2026-11-13T10:00:30Z', error: null } };
    const observation = { taskVersion: row.task.version, state: 'unavailable', observedAt: WORKER_TIME, freshUntil: '2026-11-13T10:00:30Z', needsAttention: null, canOpen: true };
    const candidate = (sessionRow: unknown, selected = active) => ({ ...value, items: [{ ...selected, sessionRow }] });
    expect(parsePersonalTaskPage(candidate(observation)).items[0]?.sessionRow.canOpen).toBe(true);
    for (const invalid of [
      candidate(undefined), candidate(null), candidate({ ...observation, taskVersion: '1' }),
      candidate({ ...observation, observedAt: null }), candidate({ ...observation, freshUntil: null }),
      candidate({ ...observation, state: 'no_session', canOpen: false }),
      candidate({ ...observation, state: 'not_registered' }),
      { ...value, items: [{ ...row, sessionRow: observation }] },
      { ...value, items: [{ ...active, task: { ...active.task, worker: { ...active.task.worker, state: 'completed' } }, sessionRow: observation }] },
      ...[{ sessionId: null }, { claimId: null }, { registration: 'not_registered' }, { error: { code: 'offline', message: 'offline' } },
        { freshUntil: null }, { observation: 'unavailable' }, { contentKind: 'terminal_recording' }].map(change => ({ ...value, items: [{ ...active, session: { ...active.session, ...change }, sessionRow: observation }] })),
    ]) expect(() => parsePersonalTaskPage(invalid)).toThrow();
    const { sessionRow: _sessionRow, ...missing } = row;
    expect(() => parsePersonalTaskPage({ ...value, items: [missing] })).toThrow();
  });
  it('requires an exact nullable Worker summary with valid IDs and Unicode name', () => {
    const value = page(), row = item();
    const worker = { workerId: workerId(6), state: 'active', machine: { id: workerId(7), name: '机器 <worker> 🖥️' } };
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
  it('requires complete projection fields and rejects invalid values and duplicate IDs', () => {
    const value = page(), row = item();
    const candidate = (changes: Record<string, unknown>) => ({ ...value, items: [{ ...row, task: { ...row.task, ...changes } }] });
    for (const key of ['createdAt', 'requiredPlatform', 'tags', 'blockedBy', 'ready']) {
      const task = { ...row.task } as Record<string, unknown>;
      delete task[key];
      expect(() => parsePersonalTaskPage({ ...value, items: [{ ...row, task }] })).toThrow();
    }
    for (const key of ['responseTaskAt', 'responseSessionAt']) {
      const missing = { ...value } as Record<string, unknown>;
      delete missing[key];
      expect(() => parsePersonalTaskPage(missing)).toThrow();
      expect(() => parsePersonalTaskPage({ ...value, [key]: 'not a timestamp' })).toThrow();
    }
    for (const changes of [
      { createdAt: null }, { requiredPlatform: 'unix' }, { tags: null }, { blockedBy: ['bad'] }, { ready: true },
      { tags: [{ id: workerId(8), name: 'one' }, { id: workerId(8), name: 'two' }] },
      { tags: [{ id: workerId(8), name: 'tag', extra: 1 }] },
      { blockedBy: [workerId(9), workerId(9)] },
      { worker: { workerId: workerId(6), state: 'unknown', machine: { id: workerId(7), name: 'machine' } } },
    ]) expect(() => parsePersonalTaskPage(candidate(changes))).toThrow();
    expect(() => parsePersonalTaskPage({ ...value, items: [row, row] })).toThrow();
    const parsed = parsePersonalTaskPage(candidate({ requiredPlatform: 'linux', tags: [{ id: workerId(8), name: '标签' }], blockedBy: [workerId(9)], worker: { workerId: workerId(6), state: 'completed', machine: { id: workerId(7), name: 'machine' } } }));
    expect(parsed.items[0]?.task).toMatchObject({ requiredPlatform: 'linux', tags: [{ id: workerId(8), name: '标签' }], blockedBy: [workerId(9)], ready: false, worker: { state: 'completed' } });
  });

  it('records body receipt before JSON decoding', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const original = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation((...args) => { now = 5100; return original(...args); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wireResponse(page(), { headers: { 'Daynight-User-ID': WORKER_USER } })));
    const result = await listPersonalTasks(null, new AbortController().signal, { userId: WORKER_USER, onPrincipalMismatch: vi.fn() });
    expect(result.receivedMonotonic).toBe(100);
    expect(performance.now() - result.receivedMonotonic).toBe(5000);
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
    expect(await listPersonalTasks('next/+', new AbortController().signal, { userId: WORKER_USER, onPrincipalMismatch: vi.fn() })).toEqual({ ...parsePersonalTaskPage(page()), receivedMonotonic: expect.any(Number) });
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/me/in-progress-tasks?limit=100&cursor=next%2F%2B');
    const mismatch = vi.fn(); fetch.mockResolvedValueOnce(wireResponse(page(), { headers: { 'Daynight-User-ID': workerId(99) } }));
    await expect(listPersonalTasks(null, new AbortController().signal, { userId: WORKER_USER, onPrincipalMismatch: mismatch })).rejects.toThrow();
    expect(mismatch).toHaveBeenCalledOnce();
  });
});
