import { describe, expect, it } from 'vitest';
import { unsupportedSessionObservation } from '../../daynight/src/api/task-observation';
import type { PersonalTaskItem } from '../src/api/personal-tasks';
import type { TaskSyncObservation } from '../src/api/types';
import { personalTaskSession, personalTaskSessionNextChange } from '../src/features/my-tasks/personal-session';
import { normalizeTaskSession, taskSessionNextChange, type TaskSessionClock } from '../src/features/task-session-summary/observation';

const taskTime = '2026-11-13T10:00:00Z';
const sessionTime = '2026-11-13T20:00:00Z';
const clock: TaskSessionClock = { startedAt: taskTime, responseTaskAt: Date.parse(taskTime), responseSessionAt: Date.parse(sessionTime), receivedMonotonic: 100 };
const observation = (changes: Partial<TaskSyncObservation> = {}): TaskSyncObservation => ({ taskVersion: 1n, state: 'working', observedAt: sessionTime, freshUntil: '2026-11-13T20:00:30Z', needsAttention: false, canOpen: true, ...changes });

describe('shared Task Session normalization', () => {
  it('uses the Task clock for the exact grace boundary while preserving independently admitted reading', () => {
    const warning = observation({ state: 'warning', needsAttention: true });
    const nearBoundary = { ...clock, responseTaskAt: Date.parse(taskTime) + 119_999 };
    expect(normalizeTaskSession(warning, nearBoundary, 100)).toEqual({ state: null, needsAttention: null, canOpen: true });
    expect(taskSessionNextChange(warning, nearBoundary, 100)).toBe(1);
    expect(normalizeTaskSession(warning, nearBoundary, 101)).toEqual({ state: 'warning', needsAttention: true, canOpen: true });
    expect(taskSessionNextChange(warning, nearBoundary, 101)).toBe(29_999);
    expect(normalizeTaskSession(warning, { ...nearBoundary, startedAt: null }, 100).state).toBe('warning');
  });

  it('expires each sample against the final Engine response clock, independently of a 25-second batch gap', () => {
    const response = { ...clock, responseSessionAt: Date.parse(sessionTime) + 25_000 };
    const first = observation();
    const last = observation({ observedAt: '2026-11-13T20:00:25Z', freshUntil: '2026-11-13T20:00:55Z' });
    expect(taskSessionNextChange(first, response, 100)).toBe(5000);
    expect(taskSessionNextChange(last, response, 100)).toBe(30_000);
    expect(normalizeTaskSession(first, response, 5100)).toEqual({ state: 'expired', needsAttention: null, canOpen: false });
    expect(normalizeTaskSession(last, response, 5100)).toEqual({ state: 'working', needsAttention: false, canOpen: true });
  });

  it('includes body decoding and all post-sampling work instead of renewing freshness on rendering', () => {
    expect(normalizeTaskSession(observation(), clock, 30_100).state).toBe('expired');
    expect(taskSessionNextChange(observation(), clock, 30_100)).toBeNull();
    const tailWork = { ...clock, responseSessionAt: Date.parse(sessionTime) + 30_000 };
    expect(normalizeTaskSession(observation(), tailWork, 100).canOpen).toBe(false);
    expect(normalizeTaskSession(observation({ freshUntil: '2026-11-13T21:00:00Z' }), clock, 30_100).state).toBe('expired');
    expect(normalizeTaskSession(observation({ freshUntil: '2026-11-13T20:00:05Z' }), clock, 5100).state).toBe('expired');
  });

  it.each(['observedAt', 'freshUntil'] as const)('expires a successful observation with null %s immediately', field => {
    const sample = observation({ [field]: null });
    expect(normalizeTaskSession(sample, clock, 100)).toEqual({ state: 'expired', needsAttention: null, canOpen: false });
    expect(taskSessionNextChange(sample, clock, 100)).toBeNull();
  });

  it('keeps unavailable ahead of expiry without inventing reading admission', () => {
    const failed = observation({ state: 'unavailable', observedAt: null, freshUntil: null, needsAttention: null, canOpen: false });
    expect(normalizeTaskSession(failed, clock, 30_100)).toEqual({ state: 'unavailable', needsAttention: null, canOpen: false });
    const unknownActivity = observation({ state: 'unavailable', needsAttention: null });
    expect(normalizeTaskSession(unknownActivity, clock, 100)).toEqual({ state: 'unavailable', needsAttention: null, canOpen: true });
    expect(normalizeTaskSession(unknownActivity, clock, 30_100)).toEqual({ state: 'unavailable', needsAttention: null, canOpen: false });
  });

  it.each(['no_session', 'not_registered', 'pending', 'working', 'notice', 'warning', 'unavailable'] as const)('keeps server-owned %s lifecycle semantics consistent across personal and project input', state => {
    const sample = observation({ state, canOpen: state !== 'no_session' && state !== 'not_registered' });
    const laterTask = { ...clock, responseTaskAt: Date.parse(taskTime) + 120_000 };
    const item: PersonalTaskItem = {
      project: { id: 'project', name: 'Project', ownerTeam: { id: 'team', kind: 'personal', name: null }, executionWarningMinutes: 120, matchedTaskCount: 1 },
      task: { id: 'task', version: '1', title: 'Task', status: 'in_progress', startedAt: taskTime, createdAt: taskTime, requiredPlatform: null,
        tags: [], blockedBy: [], ready: false, allowAgents: true, paused: false, goal: null,
        worker: state === 'no_session' ? null : { workerId: 'worker', state: 'active', machine: { id: 'machine', name: 'Machine' } } },
      session: unsupportedSessionObservation(), sessionRow: sample, observedAt: taskTime,
      responseTaskAt: new Date(laterTask.responseTaskAt).toISOString(), responseSessionAt: sessionTime, receivedMonotonic: 100,
    };
    expect(personalTaskSession(item, 100)).toEqual(normalizeTaskSession(sample, laterTask, 100));
    expect(personalTaskSessionNextChange(item, 100)).toEqual(taskSessionNextChange(sample, laterTask, 100));
  });
});
