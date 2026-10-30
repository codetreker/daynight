import { describe, expect, it } from 'vitest';
import { detailFixture, graphFixture } from './taskDetail';
import { createGraphSyncFixture, taskSyncEpoch, taskSyncFixture, taskSyncResponse, TEST_VIEWER_ID } from './taskSync';

const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';

describe('task-sync test fixtures', () => {
  it('encodes intrinsic summaries and exact wire versions with an explicit principal', async () => {
    const graph = graphFixture([detailFixture(projectId, taskId)]);
    const response = taskSyncResponse({ ...graph, project: { ...graph.project, settings: { ...graph.project.settings, version: 9_007_199_254_740_993n } } }, { viewerId: TEST_VIEWER_ID, versionForTask: () => 9_007_199_254_740_995n });
    const text = await response.text();
    expect(response.headers.get('Daynight-User-ID')).toBe(TEST_VIEWER_ID);
    expect(text).toContain('"version":9007199254740993');
    expect(text).toContain('"version":"9007199254740995"');
    const body = JSON.parse(text) as { tasks: Record<string, unknown>[] };
    expect(body.tasks[0]).toMatchObject({ requiredPlatform: null, startedAt: null, completedAt: null });
    expect(body.tasks[0]).not.toHaveProperty('ready');
    expect(body.tasks[0]).not.toHaveProperty('blockedBy');
    expect(body).not.toHaveProperty('summary');
  });

  it('uses snapshot for a missing or changed epoch and delta for an empty baseline', () => {
    const graph = graphFixture([detailFixture(projectId, taskId)]);
    const options = { versionForTask: () => 1n };
    expect(taskSyncFixture(graph, options).mode).toBe('snapshot');
    expect(taskSyncFixture(graph, { ...options, query: { epoch: taskSyncEpoch('other-project') } }).mode).toBe('snapshot');
    expect(taskSyncFixture(graph, { ...options, query: { epoch: taskSyncEpoch(projectId) } })).toMatchObject({ mode: 'delta', tasks: [{ id: taskId }] });
  });

  it('preserves the inclusive nanosecond overlap boundary', () => {
    const graph = graphFixture([
      detailFixture(projectId, taskId, { updatedAt: '2026-10-22T10:00:10.000000000Z' }),
      detailFixture(projectId, '00000000-0000-4000-8000-000000000002', { updatedAt: '2026-10-22T10:00:10.000000001Z' }),
    ]);
    const sync = taskSyncFixture(graph, { query: { epoch: taskSyncEpoch(projectId), since: '2026-10-22T10:00:20.000000001Z' }, versionForTask: () => 1n });
    expect(sync.tasks.map((task) => task.id)).toEqual(['00000000-0000-4000-8000-000000000002']);
  });

  it('tracks simulated task content versions while keeping derived state outside business content', () => {
    const graph = graphFixture([detailFixture(projectId, taskId)]);
    const fixture = createGraphSyncFixture();
    const first = fixture.toSync(graph);
    const derived = fixture.toSync({ ...graph, tasks: graph.tasks.map((task) => ({ ...task, ready: !task.ready })) });
    const changed = fixture.toSync({ ...graph, tasks: graph.tasks.map((task) => ({ ...task, titlePreview: 'Updated title' })) });
    expect(first.tasks[0]!.version).toBe(1n);
    expect(derived.tasks[0]!.version).toBe(1n);
    expect(changed.tasks[0]!.version).toBe(2n);
    expect(fixture.toSync(graph).tasks[0]!.version).toBe(3n);
    fixture.reset();
    expect(fixture.toSync(graph).epoch).not.toBe(first.epoch);
  });
});

it('takes complete properties from the explicit detail source while leaving graph rows compact', async () => {
  const detail = detailFixture(projectId, taskId, {
    properties: { pullRequests: [], future: { version: 42, nested: [null, { enabled: true }] } },
  });
  const graph = graphFixture([detail]);
  const response = taskSyncResponse(graph, {
    viewerId: TEST_VIEWER_ID, versionForTask: () => detail.version, propertiesForTask: () => detail.properties,
  });
  const wire = JSON.parse(await response.text()) as { tasks: { properties: unknown }[] };
  expect(wire.tasks[0]!.properties).toEqual(detail.properties);
  expect(graph.tasks[0]).not.toHaveProperty('properties');
  expect(taskSyncFixture(graph, { versionForTask: () => 1n }).tasks[0]!.properties).toEqual({});
});

it('tracks complete property replacement and deletion in simulated task versions', () => {
  let properties = detailFixture(projectId, taskId).properties;
  const graph = graphFixture([detailFixture(projectId, taskId)]);
  const fixture = createGraphSyncFixture({ propertiesForTask: () => properties });
  const first = fixture.toSync(graph);
  properties = { pullRequests: [{ url: 'https://example.test/pr', title: 'A PR' }] };
  const changed = fixture.toSync(graph);
  properties = {};
  const removed = fixture.toSync(graph);
  const repeated = fixture.toSync(graph);
  expect(first.tasks[0]).toMatchObject({ version: 1n, properties: { pullRequests: [] } });
  expect(changed.tasks[0]).toMatchObject({ version: 2n, properties: { pullRequests: [{ title: 'A PR' }] } });
  expect(removed.tasks[0]).toMatchObject({ version: 3n, properties: {} });
  expect(repeated.tasks[0]).toEqual(removed.tasks[0]);
});
