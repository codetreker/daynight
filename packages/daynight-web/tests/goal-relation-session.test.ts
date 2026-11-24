import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalDependencies, GoalDependenciesRead, RelatedGoal } from '../src/api/goal-dependencies';
import { ApiError } from '../src/api/client';
import type { TaskSummary } from '../src/api/types';
import { createTaskCacheScope, type CacheEvent } from '../src/features/task-cache/project-cache';
import { GoalRelationSession } from '../src/features/goal-acceptance-graph/relation-session';
import { projectGoalAcceptance } from '../src/features/goal-acceptance-graph/model';
import { combineGoalRelations } from '../src/features/goal-acceptance-graph/relation-projection';
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
const canvas = (session: GoalRelationSession, input: Map<string, TaskSummary>) => combineGoalRelations(projectId, projectGoalAcceptance(input),
  [...session.snapshot().sources.values()].flatMap(source => source.mode === 'inspection' || source.contribution === null ? [] : [source.contribution]), session.snapshot().deniedIds);

describe('Goal graph relationship session', () => {
  it('recreates a deleted local root with the same ID after its project history is replaced', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId));
    const { session, scope, event } = await prepare(read);
    await scope.observeHistory(await scope.beginSync(projectId, scope.signal), id(90), scope.signal);
    session.setRoots(roots()); await settled(session);
    event({ projectId, deletedTaskIds: [id(1)] });
    expect(session.snapshot().sources.has(id(1))).toBe(false); expect(session.snapshot().deniedIds.has(id(1))).toBe(true);
    session.setRoots(roots()); expect(read).toHaveBeenCalledTimes(1);
    event({ projectId, historyChanged: true, historyHint: true });
    session.setRoots(roots()); expect(read).toHaveBeenCalledTimes(1);
    scope.retireTaskHistory(projectId, id(90)); await scope.beginSync(projectId, scope.signal);
    event({ projectId, historyChanged: true });
    session.setRoots(roots()); await settled(session);
    expect(read).toHaveBeenCalledTimes(2); expect(session.snapshot().deniedIds.has(id(1))).toBe(false);
  });
  it('retires stale deletion qualification when an authorized root baseline arrives after a missed history event', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId));
    const { session, scope, event } = await prepare(read);
    await scope.observeHistory(await scope.beginSync(projectId, scope.signal), id(90), scope.signal);
    session.setRoots(roots()); await settled(session);
    event({ projectId, deletedTaskIds: [id(1)] }); session.setRoots(new Map());
    scope.retireTaskHistory(projectId, id(90)); await scope.beginSync(projectId, scope.signal);
    session.setRoots(roots()); await settled(session);
    expect(read).toHaveBeenCalledTimes(2); expect(session.snapshot().deniedIds.has(id(1))).toBe(false);
  });
  it('withdraws only the committed deleted peer and preserves another Goal in the same external project', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId, { prerequisites: [{ target: related(10) }, { target: related(11) }] }));
    const { session, scope, event } = await prepare(read);
    session.setRoots(roots()); await settled(session);
    vi.spyOn(scope, 'qualifyProjection').mockImplementation(async (_fence, candidates) => new Set(candidates.filter(item => item.id !== id(10)).map(item => `${item.projectId}/${item.id}`)));
    event({ projectId: externalProject, deletedTaskIds: [id(10)] });
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites.map(item => item.target?.goalId ?? null)).toEqual([null, id(11)]);
    await settled(session);
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites.map(item => item.target?.goalId ?? null)).toEqual([null, id(11)]);
  });
  it('qualifies foreign targets before publishing a late relationship page when the deletion hint was missed', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId, { prerequisites: [{ target: related(10) }], successors: [related(11)] }));
    const { session, scope } = await prepare(read);
    const qualification = vi.spyOn(scope, 'qualifyProjection').mockImplementation(async (_fence, candidates) => new Set(candidates.filter(item => item.id !== id(10)).map(item => `${item.projectId}/${item.id}`)));
    session.setRoots(roots()); await settled(session);
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites[0]?.target).toBeNull();
    expect(session.snapshot().sources.get(id(1))?.contribution?.successors.map(item => item.goalId)).toEqual([id(11)]);
    expect(qualification).toHaveBeenCalledWith(expect.any(Map), [{ projectId, id: id(1) }, { projectId: externalProject, id: id(10) }, { projectId: externalProject, id: id(11) }], expect.any(AbortSignal));
  });
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

  it.each(['inspection', 'expanded'] as const)('cancels a hidden %s source and permits a new source after fresh positive re-admission', async mode => {
    let hidden = false, hold = true, reply!: (value: GoalDependenciesRead) => void, branchSignal!: AbortSignal;
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal): Promise<GoalDependenciesRead> => {
      if (goalId === id(1)) return Promise.resolve(page(goalId, { canEdit: true, revision: '1', prerequisites: [{ edgeId: id(90), target: hidden ? null : related(10) }] }));
      if (hold) return new Promise(resolve => { reply = resolve; branchSignal = signal; });
      return Promise.resolve(page(goalId, { prerequisites: [{ target: related(11) }] }));
    });
    const { session } = await prepare(read), input = roots();
    session.setRoots(input); await settled(session);
    if (mode === 'inspection') session.inspect(id(10)); else session.expand(id(10));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    hidden = true; session.retry(id(1)); await settled(session);
    expect(branchSignal.aborted).toBe(true);
    expect(session.snapshot().sources.has(id(10))).toBe(false);
    expect(canvas(session, input).goals.has(id(10))).toBe(false);
    reply(page(id(10), { prerequisites: [{ target: related(11) }] })); await Promise.resolve();
    expect(session.snapshot().sources.has(id(10))).toBe(false);
    hidden = false; hold = false; session.retry(id(1)); await settled(session);
    expect(session.snapshot().deniedIds.has(id(10))).toBe(false);
    session.expand(id(10)); await settled(session, id(10));
    expect(session.snapshot().sources.get(id(10))?.projectId).toBe(externalProject);
    expect(canvas(session, input).goals.has(id(11))).toBe(true);
  });

  it('prunes and cancels disconnected inspection descendants immediately when an expanded ancestor becomes hidden', async () => {
    let hidden = false, childReply!: (value: GoalDependenciesRead) => void, childSignal!: AbortSignal;
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal): Promise<GoalDependenciesRead> => {
      if (goalId === id(1)) return Promise.resolve(page(goalId, { canEdit: true, revision: '1', prerequisites: [{ edgeId: id(90), target: hidden ? null : related(10) }] }));
      if (goalId === id(10)) return Promise.resolve(page(goalId, { prerequisites: [{ target: related(11) }] }));
      return new Promise(resolve => { childReply = resolve; childSignal = signal; });
    });
    const { session } = await prepare(read), input = roots();
    session.setRoots(input); await settled(session); session.expand(id(10)); await settled(session, id(10));
    session.inspect(id(11)); await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    hidden = true; session.retry(id(1)); await settled(session);
    expect(childSignal.aborted).toBe(true);
    expect(session.snapshot().sources.has(id(10))).toBe(false);
    expect(session.snapshot().sources.has(id(11))).toBe(false);
    expect(canvas(session, input).externalIds.size).toBe(0);
    childReply(page(id(11), { prerequisites: [{ target: related(12) }] })); await Promise.resolve();
    expect(session.snapshot().sources.has(id(11))).toBe(false);
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

  it('retains expanded descendants and their inspected source through replacement failure, pruning only after the complete replacement', async () => {
    let round = 0, rejectPage!: (error: unknown) => void;
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null): Promise<GoalDependenciesRead> => {
      if (goalId === id(1)) return page(goalId, { prerequisites: [{ target: related(10) }] });
      if (goalId !== id(10)) return page(goalId);
      if (cursor === null) return page(goalId, { successors: [related(20)], nextCursor: 'next' });
      if (round === 1) return new Promise((_resolve, reject) => { rejectPage = reject; });
      return page(goalId, { successors: round === 0 ? [related(21)] : [] });
    });
    const { session } = await prepare(read), input = roots();
    session.setRoots(input); await settled(session);
    session.expand(id(10)); await settled(session, id(10));
    session.inspect(id(21)); await settled(session, id(21));
    round = 1; session.retry(id(10)); await settled(session, id(10), 'partial');
    expect(canvas(session, input).goals.has(id(21))).toBe(true);
    expect(session.snapshot().sources.has(id(21))).toBe(true);
    rejectPage(new ApiError('network')); await settled(session, id(10), 'failed');
    expect(canvas(session, input).goals.has(id(21))).toBe(true);
    expect(session.snapshot().sources.has(id(21))).toBe(true);
    round = 2; session.retry(id(10)); await settled(session, id(10));
    expect(canvas(session, input).goals.has(id(21))).toBe(false);
    expect(session.snapshot().sources.has(id(21))).toBe(false);
    expect(session.snapshot().sources.get(id(10))?.mode).toBe('expanded');
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
  it('preserves terminal focus and retained successor pages during reentry while withdrawing a matched hidden prerequisite immediately', async () => {
    let hidden = false, rejectPage!: (error: unknown) => void;
    const read = vi.fn(async (_project: string, goalId: string, cursor: string | null): Promise<GoalDependenciesRead> => {
      if (cursor !== null && hidden) return new Promise((_resolve, reject) => { rejectPage = reject; });
      return page(goalId, { canEdit: true, revision: '1', prerequisites: [{ edgeId: id(90), target: hidden ? null : related(10) }],
        successors: [related(cursor === null ? 20 : 21)], nextCursor: cursor === null ? 'next' : null });
    });
    const { session } = await prepare(read), input = roots();
    input.set(id(1), { ...input.get(id(1))!, status: 'done' });
    session.setRoots(input, id(1)); await settled(session);
    hidden = true; session.reenter(); await settled(session, id(1), 'partial');
    expect(session.snapshot().sources.get(id(1))?.mode).toBe('root');
    expect(session.snapshot().deniedIds.has(id(10))).toBe(true);
    expect(session.snapshot().sources.get(id(1))!.hiddenCount).toBe(1);
    const projection = combineGoalRelations(projectId, projectGoalAcceptance(input, id(1)), [session.snapshot().sources.get(id(1))!.contribution!], session.snapshot().deniedIds);
    expect(projection.goals.has(id(10))).toBe(false);
    expect(projection.goals.has(id(21))).toBe(true);
    expect(projection.rootIds.has(id(1))).toBe(true);
    rejectPage(new ApiError('network')); await settled(session, id(1), 'failed');
    expect(session.snapshot().sources.get(id(1))!.contribution?.successors.map(goal => goal.goalId)).toEqual([id(20), id(21)]);
  });

  it.each(['done', 'cancelled'] as const)('reads a focused %s Goal as a root while keeping unfocused terminal Goals excluded', async status => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId, { prerequisites: [{ target: related(10, 'done') }] }));
    const { session } = await prepare(read), input = roots(2);
    for (const [goalId, goal] of input) input.set(goalId, { ...goal, status });
    session.setRoots(input, id(1)); await settled(session);
    expect([...session.snapshot().sources.keys()]).toEqual([id(1)]);
    expect(session.snapshot().sources.get(id(1))?.mode).toBe('root');
    const projection = combineGoalRelations(projectId, projectGoalAcceptance(input, id(1)), [session.snapshot().sources.get(id(1))!.contribution!], new Set());
    expect(projection.rootIds).toEqual(new Set([id(1)]));
    expect(projection.goals.has(id(2))).toBe(false);
    expect(projection.edges).toEqual([{ source: id(10), target: id(1), external: true }]);
    session.reenter(); await settled(session);
    expect([...session.snapshot().sources.keys()]).toEqual([id(1)]);
    expect(session.snapshot().sources.get(id(1))?.mode).toBe('root');
    expect(read).toHaveBeenCalledTimes(2);
    session.setRoots(input);
    expect(session.snapshot().sources.size).toBe(0);
  });
  it('inspects uncovered Goals without expanding and reuses completed reads for repeated expansion', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId, { prerequisites: [{ target: related(goalId === id(1) ? 10 : 11) }] }));
    const { session } = await prepare(read), input = roots();
    session.setRoots(input); await settled(session);
    session.inspect(id(10)); await settled(session, id(10));
    expect(read.mock.calls[1]).toEqual([externalProject, id(10), null, expect.any(AbortSignal), expect.any(Object)]);
    expect(session.snapshot().sources.get(id(10))?.mode).toBe('inspection');
    expect(canvas(session, input).goals.has(id(11))).toBe(false);
    session.expand(id(10)); session.expand(id(10)); session.inspect(id(10));
    expect(canvas(session, input).goals.has(id(11))).toBe(true);
    expect(session.snapshot().sources.get(id(10))?.mode).toBe('expanded');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('upgrades an inflight inspection without a duplicate read and cancels disconnected branches', async () => {
    let resolve!: (value: GoalDependenciesRead) => void, branchSignal!: AbortSignal;
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal) => goalId === id(1)
      ? Promise.resolve(page(goalId, { prerequisites: [{ target: related(10) }] }))
      : new Promise<GoalDependenciesRead>(done => { resolve = done; branchSignal = signal; }));
    const { session } = await prepare(read), input = roots();
    session.setRoots(input); await settled(session); session.inspect(id(10));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    session.expand(id(10)); expect(read).toHaveBeenCalledTimes(2);
    session.setRoots(new Map());
    expect(branchSignal.aborted).toBe(true);
    expect(session.snapshot().sources.size).toBe(0);
    resolve(page(id(10), { prerequisites: [{ target: related(11) }] })); await Promise.resolve();
    expect(session.snapshot().sources.size).toBe(0);
  });

  it('retains shared expanded sources until every exposing root withdraws and prevents reverse-edge self-ownership', async () => {
    const removed = new Set<string>();
    const read = vi.fn(async (_project: string, goalId: string) => goalId === id(10)
      ? page(goalId, { prerequisites: [{ target: related(11) }], successors: [{ ...related(1), projectId, projectName: 'Local' }] })
      : page(goalId, { prerequisites: goalId === id(11) || removed.has(goalId) ? [] : [{ target: related(10) }] }));
    const { session } = await prepare(read), input = roots(2);
    session.setRoots(input); await settled(session, id(2)); session.expand(id(10)); await settled(session, id(10));
    session.inspect(id(11)); await settled(session, id(11));
    removed.add(id(1)); session.retry(id(1)); await settled(session);
    expect(session.snapshot().sources.get(id(10))?.mode).toBe('expanded');
    removed.add(id(2)); session.retry(id(2)); await settled(session, id(2));
    expect(session.snapshot().sources.has(id(10))).toBe(false);
    expect(session.snapshot().sources.has(id(11))).toBe(false);
    expect(canvas(session, input).externalIds.size).toBe(0);
  });

  it('does not authorize inspecting or expanding from retained unqualified presentation', async () => {
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId, { prerequisites: [{ target: related(10) }] }));
    const { session } = await prepare(read);
    session.setRoots(roots()); await settled(session); session.setRoots(null);
    session.inspect(id(10)); session.expand(id(10));
    expect(read).toHaveBeenCalledTimes(1);
    expect(session.snapshot().sources.has(id(10))).toBe(false);
  });
  it('cancels four terminal inspections after synchronized local dependency removal and immediately dispatches newly eligible roots', async () => {
    const input = roots(6), terminalIds = [id(2), id(3), id(4), id(5)];
    for (const [goalId, goal] of input) if (goalId !== id(1)) input.set(goalId, { ...goal, status: 'done' });
    input.set(id(1), { ...input.get(id(1))!, dependsOn: terminalIds });
    const pending = new Map<string, AbortSignal>();
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal) => {
      if (terminalIds.includes(goalId)) return new Promise<GoalDependenciesRead>((_resolve, reject) => {
        pending.set(goalId, signal);
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return Promise.resolve(page(goalId, { prerequisites: goalId === id(1) ? terminalIds.map(targetId => ({
        target: { ...related(2, 'done'), goalId: targetId, projectId, projectName: 'Local', kind: 'internal' as const },
      })) : [] }));
    });
    const { session } = await prepare(read);
    session.setRoots(input); await settled(session);
    for (const terminalId of terminalIds) session.inspect(terminalId);
    await waitFor(() => expect(pending.size).toBe(4));
    input.set(id(1), { ...input.get(id(1))!, dependsOn: [], version: 2n });
    input.set(id(6), { ...input.get(id(6))!, status: 'todo', version: 2n });
    session.setRoots(new Map(input));
    expect([...pending.values()].every(signal => signal.aborted)).toBe(true);
    expect(terminalIds.every(goalId => !session.snapshot().sources.has(goalId))).toBe(true);
    await settled(session, id(6)); await settled(session);
    expect(read.mock.calls.filter(([, goalId]) => goalId === id(1))).toHaveLength(2);
    expect(read.mock.calls.filter(([, goalId]) => goalId === id(6))).toHaveLength(1);
    expect(canvas(session, input).goals.has(id(2))).toBe(false);
  });

  it('keeps a removed local terminal prerequisite out of expanded foreign successors when the root refresh fails', async () => {
    const input = roots(2), local = (n: number, status: RelatedGoal['status']): RelatedGoal => ({
      ...related(n, status), projectId, projectName: 'Local', kind: 'internal',
    });
    input.set(id(1), { ...input.get(id(1))!, dependsOn: [id(2)] });
    input.set(id(2), { ...input.get(id(2))!, status: 'done' });
    let failing = false, inspectionSignal!: AbortSignal;
    const read = vi.fn((_project: string, goalId: string, _cursor: string | null, signal: AbortSignal) => {
      if (goalId === id(2)) return new Promise<GoalDependenciesRead>((_resolve, reject) => {
        inspectionSignal = signal;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      if (goalId === id(1) && failing) return Promise.reject(new ApiError('network'));
      return Promise.resolve(page(goalId, goalId === id(1)
        ? { prerequisites: [{ target: local(2, 'done') }, { target: related(10, 'done') }] }
        : { successors: [{ ...local(1, 'todo'), kind: 'external' }, { ...local(2, 'done'), kind: 'external' }] }));
    });
    const { session } = await prepare(read);
    session.setRoots(input); await settled(session);
    session.expand(id(10)); await settled(session, id(10));
    session.inspect(id(2)); await waitFor(() => expect(inspectionSignal).toBeDefined());
    expect(canvas(session, input).goals.has(id(2))).toBe(true);
    failing = true;
    input.set(id(1), { ...input.get(id(1))!, dependsOn: [], version: 2n });
    session.setRoots(new Map(input)); await settled(session, id(1), 'failed');
    expect(session.snapshot().sources.get(id(1))?.contribution?.prerequisites[0]?.target?.goalId).toBe(id(2));
    expect(inspectionSignal.aborted).toBe(true);
    expect(session.snapshot().sources.has(id(2))).toBe(false);
    expect(canvas(session, input).goals.has(id(2))).toBe(false);
    expect(canvas(session, input).goals.has(id(10))).toBe(true);
    expect(session.snapshot().sources.get(id(10))?.mode).toBe('expanded');
    session.inspect(id(2));
    expect(session.snapshot().sources.has(id(2))).toBe(false);
  });

  it('retains terminal local and same-foreign-Project inspection sources reached through an expanded foreign source', async () => {
    const input = roots(2);
    input.set(id(2), { ...input.get(id(2))!, status: 'done' });
    const local = { ...related(2, 'done'), projectId, projectName: 'Local' };
    const read = vi.fn(async (_project: string, goalId: string) => page(goalId, {
      prerequisites: goalId === id(1) ? [{ target: related(10) }] : goalId === id(10)
        ? [{ target: local }, { target: { ...related(11), kind: 'internal' as const } }]
        : goalId === id(2) ? [{ target: related(12) }] : [],
    }));
    const { session } = await prepare(read);
    session.setRoots(input); await settled(session);
    session.expand(id(10)); await settled(session, id(10));
    session.inspect(id(2)); session.inspect(id(11));
    await settled(session, id(2)); await settled(session, id(11));
    session.setRoots(new Map(input));
    expect(session.snapshot().sources.get(id(2))?.projectId).toBe(projectId);
    expect(session.snapshot().sources.get(id(11))?.projectId).toBe(externalProject);
    expect(session.snapshot().sources.get(id(2))?.mode).toBe('inspection');
    expect(session.snapshot().sources.get(id(11))?.mode).toBe('inspection');
    expect(canvas(session, input).goals.has(id(2))).toBe(true);
    expect(canvas(session, input).goals.has(id(11))).toBe(true);
    expect(canvas(session, input).goals.has(id(12))).toBe(false);
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
