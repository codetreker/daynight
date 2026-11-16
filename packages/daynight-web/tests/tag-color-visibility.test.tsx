import { expect, it, vi } from 'vitest';
import { TaskMemberRow } from '../src/features/task-graph/TaskMemberRow';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { TaskPauseProvider } from '../src/features/task-pause/TaskPause';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';

const watched = vi.hoisted(() => ({ ids: [] as string[][] }));
vi.mock('../src/features/task-tags/useTagColors', () => ({ useTagColors: (_project: string, ids: readonly string[]) => {
  watched.ids.push([...ids]);
  return { items: new Map(), loading: ids.length > 0, error: null, retry: vi.fn() };
} }));

it('subscribes only while an expanded chain member is visible and preserves its mounted row', () => {
  const projectId = '10000000-0000-4000-8000-000000000001';
  const tagId = '20000000-0000-4000-8000-000000000012';
  const detail = detailFixture(projectId, '20000000-0000-4000-8000-000000000001', { tags: [{ id: tagId, name: 'Visible tag' }] });
  const snapshot = snapshotFixture([detail]);
  const task = snapshot.index.nodes.get(detail.id)!;
  const view = (active: boolean) => <TaskPauseProvider taskIds={new Set()}><TaskExecutionClockProvider projectId={projectId} snapshot={snapshot}>
    <TaskMemberRow projectId={projectId} task={task} title={detail.title} tags={detail.tags} active={active} instanceId="chain" workerMachine={undefined} onOpenTask={vi.fn()} />
  </TaskExecutionClockProvider></TaskPauseProvider>;
  watched.ids = [];
  const rendered = renderWithLocale(view(false), { locale: 'en', taskCache: true });
  const row = rendered.container.querySelector('.task-row-title');
  expect(row).not.toBeNull();
  expect(watched.ids.every(ids => ids.length === 0)).toBe(true);
  watched.ids = []; rendered.rerender(view(true));
  expect(watched.ids.some(ids => ids.includes(tagId))).toBe(true);
  expect(rendered.container.querySelector('.task-row-title')).toBe(row);
  watched.ids = []; rendered.rerender(view(false));
  expect(watched.ids.every(ids => ids.length === 0)).toBe(true);
  expect(rendered.container.querySelector('.task-row-title')).toBe(row);
});
