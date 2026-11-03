import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTask, getTask } from '../src/api/client';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { readCachedDetail, saveDetail } from '../src/features/task-detail/detail-cache';
import { admitTaskGraph, createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), deleteTask: vi.fn(), getTask: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const target = '20000000-0000-4000-8000-000000000001'; const ordinary = '20000000-0000-4000-8000-000000000002'; const external = '20000000-0000-4000-8000-000000000003'; const downstream = '20000000-0000-4000-8000-000000000004';
const deleted = detailFixture(project, target, { version: 9n });
const ordinaryBefore = detailFixture(project, ordinary, { title: 'Ordinary successor', version: 4n, dependsOn: [target], blockedBy: [target], ready: false });
const externalBefore = detailFixture(project, external, { title: 'External successor', version: 8n, dependsOn: [target], externalDependsOn: [target], blockedBy: [target], ready: false });
const downstreamBefore = detailFixture(project, downstream, { title: 'Transitive successor', dependsOn: [ordinary], blockedBy: [ordinary], ready: false });
const before = [deleted, ordinaryBefore, externalBefore, downstreamBefore];
let world: ReturnType<typeof createTaskSessionWorld>; let sessions: TaskDetailSessions;
beforeEach(() => { world = createTaskSessionWorld(); sessions = new TaskDetailSessions(world.scope); vi.mocked(deleteTask).mockReset(); vi.mocked(getTask).mockReset().mockImplementation(async (_project, id) => before.find((detail) => detail.id === id)!); });
afterEach(() => { sessions.dispose(); world.dispose(); });

describe('combined deletion snapshot admission', () => {
  it('replaces deleted summaries and both successor classifications, invalidates details and derives readiness from the remaining graph', async () => {
    await world.sync(before); const oldTicket = await world.scope.beginSync(project, world.scope.signal);
    for (const detail of before) await saveDetail(world.scope, oldTicket, detail, world.scope.signal);
    for (const id of [target, ordinary]) { sessions.observe(project, id, world.node(project, id), true); sessions.load(project, id, 1); await waitFor(() => expect(sessions.snapshot(project, id).status).toBe('ready')); }
    expect(await readCachedDetail(world.scope, oldTicket, ordinary, world.scope.signal)).toMatchObject({ version: 4n, dependsOn: [target] });
    vi.mocked(deleteTask).mockResolvedValueOnce(); sessions.deleteTask(project, target, deleted.version, true); await waitFor(() => expect(sessions.snapshot(project, target).status).toBe('deleted'));
    const ordinaryAfter = { ...ordinaryBefore, version: 5n, dependsOn: [], blockedBy: [], ready: true, updatedAt: '2026-10-22T11:00:00Z' };
    const externalAfter = { ...externalBefore, version: 9n, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, updatedAt: '2026-10-22T11:00:00Z' };
    const after = [ordinaryAfter, externalAfter, downstreamBefore]; const byId = new Map(after.map((detail) => [detail.id, detail]));
    const replacement = await admitTaskGraph(world.scope, graphFixture(after), { epoch: crypto.randomUUID(), versionForTask: (node) => byId.get(node.id)!.version, propertiesForTask: (node) => byId.get(node.id)!.properties });
    expect(replacement.manifest.cacheGeneration).not.toBe(oldTicket.cacheGeneration); expect(replacement.index.nodes.has(target)).toBe(false); expect(replacement.index.successors.has(target)).toBe(false);
    expect(replacement.graph.summary).toEqual({ total: 3, todo: 3, inProgress: 0, done: 0, ready: 2, blocked: 1 });
    expect(replacement.versions.get(ordinary)).toBe(5n); expect(replacement.versions.get(external)).toBe(9n); expect(replacement.versions.get(downstream)).toBe(1n);
    expect(replacement.index.nodes.get(ordinary)).toMatchObject({ dependsOn: [], blockedBy: [], ready: true }); expect(replacement.index.nodes.get(external)).toMatchObject({ dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
    expect(replacement.index.nodes.get(downstream)).toMatchObject({ dependsOn: [ordinary], blockedBy: [ordinary], ready: false });
    const newTicket = await world.scope.beginSync(project, world.scope.signal);
    for (const id of [target, ordinary, external, downstream]) expect(await readCachedDetail(world.scope, newTicket, id, world.scope.signal)).toBeNull();
    await expect(saveDetail(world.scope, oldTicket, ordinaryBefore, world.scope.signal)).rejects.toMatchObject({ name: 'AbortError' });
    sessions.observe(project, target, undefined, true); sessions.observe(project, ordinary, replacement.index.nodes.get(ordinary), true); expect(sessions.snapshot(project, ordinary).detail).toBeNull();
    vi.mocked(getTask).mockResolvedValueOnce(ordinaryAfter); sessions.load(project, ordinary, 2); await waitFor(() => expect(sessions.snapshot(project, ordinary).detail).toEqual(ordinaryAfter));
    expect(sessions.snapshot(project, target).status).toBe('deleted'); expect(vi.mocked(deleteTask)).toHaveBeenCalledExactlyOnceWith(project, target, 9n, true, expect.any(AbortSignal), expect.anything());
  });
});
