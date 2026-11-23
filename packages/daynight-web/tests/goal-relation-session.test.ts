import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalDependencies, GoalDependenciesRead, RelatedGoal } from '../src/api/goal-dependencies';
import { ApiError } from '../src/api/client';
import type { TaskSummary } from '../src/api/types';
import { createTaskCacheScope, type CacheEvent } from '../src/features/task-cache/project-cache';
import { GoalRelationSession } from '../src/features/goal-acceptance-graph/relation-session';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const projectId = '00000000-0000-4000-8000-000000000100';
const externalProject = '00000000-0000-4000-8000-000000000200';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const roots = (count = 1): Map<string, TaskSummary> => new Map(Array.from({ length: count }, (_, n) => {
  const { description: _description, blockedBy: _blocked, ready: _ready, projectId: _project, ...goal } = detailFixture(projectId, id(n + 1), { type: 'goal', ready: false, title: `Goal ${n + 1}` });
  return [goal.id, { ...goal, titlePreview: goal.title, titleTruncated: false }];
}));
const related = (n: number, status: RelatedGoal['status'] = 'todo'): RelatedGoal => ({ projectId: externalProject, projectName: 'Other project', goalId: id(n), title: `External ${n}`, status, kind: 'external' });
const page = (goalId: string, changes: Partial<GoalDependencies> = {}): GoalDependenciesRead => ({ kind: 'available', page: { goalId, canEdit: false, completionBlocked: false, prerequisites: [], successors: [], nextCursor: null, ...changes } });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const release of cleanup.splice(0)) release(); });
const prepare = async (read: ConstructorParameters<typeof GoalRelationSession>[2], timeout = 30_000) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  await scope.beginSync(projectId, scope.signal);
  let event!: (value: CacheEvent) => void;
  vi.spyOn(scope, 'subscribe').mockImplementation(listener => { event = listener; return () => {}; });
  const session = new GoalRelationSession(scope, projectId, read, timeout);
  cleanup.push(() => { session.dispose(); scope.dispose(); });
  return { session, scope, event: (value: CacheEvent) => event(value) };
};
const settled = (session: GoalRelationSession, goalId = id(1), phase = 'ready') => waitFor(() => expect(session.snapshot().sources.get(goalId)?.phase).toBe(phase));

describe('Goal graph relationship session', () => {
  it('withdraws a matched hidden prerequisite immediately through held and failed paging, rejecting older responses and admitting a fresh positive read', async () => {
    let hidden = false, holdPeer = false, peerReply!: (value: GoalDependenciesRead) => void, rejectPage!: (error: unknown) => void;
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null): Promise<GoalDependenciesRead> => {
      if (goalId === id(2)) {
        if (holdPeer) return new Promise(resolve => { peerReply = resolve; });
        return page(goalId, { successors: [related(10)] });
      }
      if (cursor !== null) return new Promise((_resolve, reject) => { rejectPage = reject; });
      return page(goalId, { canEdit: true, revision: '1', prerequisites: [{ edgeId: id(90), target: hidden ? null : related(10) }],
        successors: [related(20)], nextCursor: hidden ? 'next' : null });
    });
    const { session, scope } = await prepare(read), revoke = vi.spyOn(scope, 'revokeProject');
    session.setRoots(roots(2)); await settled(session); await settled(session, id(2));
    holdPeer = true; session.retry(id(2)); await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    hidden = true; session.retry(id(1)); await settled(session, id(1), 'partial');
    expect(session.snapshot().deniedIds.has(id(10))).toBe(true);
    expect(session.snapshot().sources.get(id(1))!.contribution?.prerequisites[0]?.target).toBeNull();
    expect(session.snapshot().sources.get(id(1))!.hiddenCount).toBe(1);
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors[0]?.goalId).toBe(id(20));
    expect(session.snapshot().sources.get(id(2))!.contribution?.successors).toEqual([]);
    rejectPage(new ApiError('network')); await settled(session, id(1), 'failed');
    peerReply(page(id(2), { successors: [related(10)] })); await settled(session, id(2));
    expect(session.snapshot().deniedIds.has(id(10))).toBe(true);
    expect(session.snapshot().sources.get(id(2))!.contribution?.successors).toEqual([]);
    holdPeer = false; session.retry(id(2)); await settled(session, id(2));
    expect(session.snapshot().deniedIds.has(id(10))).toBe(false);
    expect(session.snapshot().sources.get(id(2))!.contribution?.successors[0]?.goalId).toBe(id(10));
    session.retry(id(1)); await settled(session, id(1), 'partial');
    expect(session.snapshot().deniedIds.has(id(10))).toBe(true);
    expect(session.snapshot().sources.get(id(2))!.contribution?.successors).toEqual([]);
    rejectPage(new ApiError('network')); await settled(session, id(1), 'failed');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('retires the target source and keeps synchronized local identity denied across reconciliation and its late reply', async () => {
    let hidden = false, targetReply!: (value: GoalDependenciesRead) => void, targetSignal!: AbortSignal;
    const target = { ...related(2), projectId, projectName: 'Local', kind: 'internal' as const };
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal): Promise<GoalDependenciesRead> => goalId === id(2)
      ? new Promise(resolve => { targetReply = resolve; targetSignal = signal; })
      : Promise.resolve(page(goalId, { canEdit: true, revision: '1', prerequisites: [{ edgeId: id(90), target: hidden ? null : target }] })));
    const { session } = await prepare(read), input = roots(2);
    session.setRoots(input); await settled(session); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    hidden = true; session.retry(id(1)); await settled(session);
    expect(targetSignal.aborted).toBe(true);
    expect(session.snapshot().sources.has(id(2))).toBe(false);
    expect(session.snapshot().deniedIds.has(id(2))).toBe(true);
    session.setRoots(new Map(input));
    expect(session.snapshot().sources.has(id(2))).toBe(false);
    targetReply(page(id(2), { successors: [related(30)] })); await Promise.resolve();
    expect(session.snapshot().sources.has(id(2))).toBe(false);
    expect(session.snapshot().deniedIds.has(id(2))).toBe(true);
  });

  it('withdraws the matched target before rejecting a conflicting replacement while retaining other legal context', async () => {
    let hidden = false;
    const read = vi.fn(async (_project: string, goalId: string) => goalId === id(1)
      ? page(goalId, { canEdit: true, revision: '1', prerequisites: [{ edgeId: id(90), target: hidden ? null : related(10) }], successors: hidden ? [related(11)] : [related(20)] })
      : page(goalId, { prerequisites: [{ target: related(11) }], successors: [related(10)] }));
    const { session } = await prepare(read), input = roots(2);
    input.set(id(1), { ...input.get(id(1))!, dependsOn: [id(2)] });
    session.setRoots(input); await settled(session); await settled(session, id(2));
    hidden = true; session.retry(id(1)); await settled(session, id(1), 'conflict');
    expect(session.snapshot().deniedIds.has(id(10))).toBe(true);
    expect(session.snapshot().sources.get(id(1))!.contribution?.prerequisites[0]?.target).toBeNull();
    expect(session.snapshot().sources.get(id(1))!.hiddenCount).toBe(1);
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors[0]?.goalId).toBe(id(20));
    expect(session.snapshot().sources.get(id(2))!.contribution?.successors).toEqual([]);
    expect(session.snapshot().sources.get(id(2))!.contribution?.prerequisites[0]?.target?.goalId).toBe(id(11));
  });

  it.each([undefined, id(91)])('does not infer withdrawal from an unmatched hidden prerequisite edge %s', async edgeId => {
    let hidden = false, rejectPage!: (error: unknown) => void;
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null): Promise<GoalDependenciesRead> => {
      if (cursor !== null) return new Promise((_resolve, reject) => { rejectPage = reject; });
      return page(goalId, { prerequisites: hidden ? [{ ...(edgeId === undefined ? {} : { edgeId }), target: null }] : [{ edgeId: id(90), target: related(10) }], nextCursor: hidden ? 'next' : null });
    });
    const { session } = await prepare(read);
    session.setRoots(roots()); await settled(session); hidden = true; session.retry(id(1)); await settled(session, id(1), 'partial');
    expect(session.snapshot().deniedIds.has(id(10))).toBe(false);
    expect(session.snapshot().sources.get(id(1))!.contribution?.prerequisites[0]?.target?.goalId).toBe(id(10));
    rejectPage(new ApiError('network')); await settled(session, id(1), 'failed');
  });

  it('retains prior downstream pages through held and failed replacement, removing absent Goals only on complete replacement', async () => {
    let round = 0, rejectPage!: (error: unknown) => void;
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null): Promise<GoalDependenciesRead> => {
      if (cursor === null) return page(goalId, { successors: [related(20)], nextCursor: 'next' });
      if (round === 1) return new Promise((_resolve, reject) => { rejectPage = reject; });
      return page(goalId, { successors: round === 0 ? [related(21)] : [] });
    });
    const { session } = await prepare(read);
    session.setRoots(roots()); await settled(session);
    const prior = session.snapshot().sources.get(id(1))!.contribution;
    round = 1; session.retry(id(1)); await settled(session, id(1), 'partial');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    expect(session.snapshot().sources.get(id(1))!.contribution).toBe(prior);
    rejectPage(new ApiError('network')); await settled(session, id(1), 'failed');
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors.map(goal => goal.goalId)).toEqual([id(20), id(21)]);
    round = 2; session.retry(id(1)); await settled(session);
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors.map(goal => goal.goalId)).toEqual([id(20)]);
  });

  it('retains a legal prior read when capability becomes unavailable while trusted withdrawal still removes it immediately', async () => {
    let supported = true;
    const read = vi.fn(async (_project: string, goalId: string): Promise<GoalDependenciesRead> => supported ? page(goalId, { successors: [related(20)] }) : { kind: 'unavailable' });
    const { session, event } = await prepare(read);
    session.setRoots(roots()); await settled(session);
    supported = false; session.retry(id(1)); await settled(session, id(1), 'unavailable');
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors[0]?.goalId).toBe(id(20));
    event({ projectId: externalProject, accessRevoked: true });
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors).toEqual([]);
  });
  it('bounds source concurrency at four and cancels every owned request on close', async () => {
    const pending: { goalId: string; signal: AbortSignal; resolve: (page: GoalDependenciesRead) => void }[] = [];
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal) => new Promise<GoalDependenciesRead>((resolve, reject) => {
      pending.push({ goalId, signal, resolve }); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const { session } = await prepare(read);
    session.setRoots(roots(6));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    pending[0]!.resolve(page(pending[0]!.goalId));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(5));
    session.dispose();
    expect(pending.slice(1).every(request => request.signal.aborted)).toBe(true);
    await Promise.resolve(); expect(read).toHaveBeenCalledTimes(5);
  });

  it('reads downstream pages sequentially and keeps partial confirmed relationships on a later failure', async () => {
    const cursors: (string | null)[] = [];
    let failing = true;
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null) => {
      cursors.push(cursor);
      if (cursor !== null && failing) throw new ApiError('network');
      return page(goalId, { prerequisites: [{ target: related(10) }, { target: null }], successors: [related(cursor === null ? 20 : 21)], nextCursor: cursor === null ? 'next' : null });
    });
    const { session } = await prepare(read);
    session.setRoots(roots()); await settled(session, id(1), 'failed');
    expect(cursors).toEqual([null, 'next']);
    expect(session.snapshot().sources.get(id(1))?.contribution?.successors.map(goal => goal.goalId)).toEqual([id(20)]);
    expect(session.snapshot().sources.get(id(1))?.hiddenCount).toBe(1);
    failing = false; session.retry(id(1)); await settled(session);
    expect(session.snapshot().sources.get(id(1))?.contribution?.successors.map(goal => goal.goalId)).toEqual([id(20), id(21)]);
    expect(cursors).toEqual([null, 'next', null, 'next']);
  });

  it.each(['identity', 'cursor'])('rejects an inconsistent %s between pages without inventing a complete branch', async mismatch => {
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null) => page(goalId, {
      prerequisites: [{ target: related(cursor !== null && mismatch === 'identity' ? 11 : 10) }],
      nextCursor: cursor === null || mismatch === 'cursor' ? 'next' : null,
    }));
    const { session } = await prepare(read);
    session.setRoots(roots()); await settled(session, id(1), 'failed');
    expect(read).toHaveBeenCalledTimes(2);
    expect(session.snapshot().sources.get(id(1))?.error).toBeInstanceOf(ApiError);
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites[0]?.target?.goalId).toBe(id(10));
  });

  it('preserves the local graph and rejects an independently read reversed external edge that creates a cycle', async () => {
    let reversed = false;
    const read = vi.fn(async (_project: string, goalId: string) => goalId === id(1)
      ? page(goalId, { prerequisites: [{ target: related(10) }] })
      : page(goalId, reversed ? { successors: [related(10)] } : { prerequisites: [{ target: related(10) }] }));
    const { session } = await prepare(read);
    const input = roots(2); input.set(id(2), { ...input.get(id(2))!, dependsOn: [id(1)] });
    session.setRoots(input); await settled(session, id(2));
    reversed = true; session.retry(id(2)); await settled(session, id(2), 'conflict');
    expect(session.snapshot().sources.get(id(2))?.contribution?.prerequisites[0]?.target?.goalId).toBe(id(10));
    expect(session.snapshot().sources.get(id(2))?.contribution?.successors).toEqual([]);
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites[0]?.target?.goalId).toBe(id(10));
    expect(input.get(id(2))?.dependsOn).toEqual([id(1)]);
  });

  it('rechecks retained contributions when a newly committed local edge creates a cycle', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => goalId === id(1)
      ? page(goalId, { prerequisites: [{ target: related(10) }] }) : page(goalId, { successors: [related(10)] }));
    const { session } = await prepare(read);
    const input = roots(2); session.setRoots(input); await settled(session, id(2));
    input.set(id(2), { ...input.get(id(2))!, dependsOn: [id(1)], version: 2n });
    session.setRoots(new Map(input));
    expect(session.snapshot().sources.get(id(2))?.phase).toBe('conflict');
    expect(session.snapshot().sources.get(id(2))?.contribution).toBeNull();
  });

  it('distinguishes unsupported reads and trusted source denial without withdrawing the Project', async () => {
    const read = vi.fn(async (_project: string, goalId: string): Promise<GoalDependenciesRead> => {
      if (goalId === id(1)) return { kind: 'unavailable' };
      throw new ApiError('server', 403, 'forbidden');
    });
    const { session, scope } = await prepare(read);
    const revoke = vi.spyOn(scope, 'revokeProject');
    session.setRoots(roots(2)); await settled(session, id(1), 'unavailable'); await settled(session, id(2), 'denied');
    expect(session.snapshot().deniedIds).toEqual(new Set([id(2)]));
    expect(revoke).not.toHaveBeenCalled();
  });

  it('filters a withdrawn peer and rejects its late page across all source generations', async () => {
    let resolve!: (page: GoalDependenciesRead) => void;
    const read = vi.fn((_project: string, goalId: string) => read.mock.calls.length === 1 ? Promise.resolve(page(goalId, { prerequisites: [{ target: related(10) }] }))
      : new Promise<GoalDependenciesRead>(done => { resolve = done; }));
    const { session, event } = await prepare(read);
    session.setRoots(roots()); await settled(session); session.retry(id(1)); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    event({ projectId: externalProject, accessRevoked: true });
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites[0]?.target).toBeNull();
    resolve(page(id(1), { prerequisites: [{ target: related(10) }] })); await Promise.resolve();
    expect(session.snapshot().sources.get(id(1))?.phase).toBe('interrupted');
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites[0]?.target).toBeNull();
  });

  it('does not request roots from retained unqualified presentation and times out dispatched requests', async () => {
    const read = vi.fn((_project: string, _goal: string, _cursor: string | null, signal: AbortSignal, admission: Parameters<NonNullable<ConstructorParameters<typeof GoalRelationSession>[2]>>[4]) => new Promise<GoalDependenciesRead>((_resolve, reject) => {
      admission.onDispatch?.(); signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const { session } = await prepare(read, 10);
    session.setRoots(null); session.reenter(); expect(read).not.toHaveBeenCalled();
    session.setRoots(roots()); await settled(session, id(1), 'failed');
    expect(session.snapshot().sources.get(id(1))?.error).toMatchObject({ kind: 'network' });
  });
});
