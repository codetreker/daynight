import { fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GoalList } from '../src/features/projects/GoalList';
import { StandaloneList } from '../src/features/projects/StandaloneList';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { TaskPauseProvider } from '../src/features/task-pause/TaskPause';
import { currentTaskTags, TaskTagList } from '../src/features/task-tags/TaskTagList';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';

const project = '10000000-0000-4000-8000-000000000001';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tag = (n: number, name: string) => ({ id: id(n), name });
const goal = detailFixture(project, id(1), { type: 'goal', title: 'Goal', tags: [tag(10, 'Goal tag')] });
const single = detailFixture(project, id(2), { title: 'Single', tags: [tag(11, 'Single tag')] });
const child = detailFixture(project, id(3), { title: 'Child', parentId: goal.id, tags: [tag(12, 'Child tag')] });
const chain = detailFixture(project, id(4), { title: 'Chain child', parentId: goal.id, dependsOn: [child.id], tags: [tag(13, 'Chain tag')] });
const noop = vi.fn();
const snapshot = snapshotFixture([goal, single, child, chain]);
const view = (summaries = snapshot.summaries) => <TaskPauseProvider taskIds={new Set()}><TaskExecutionClockProvider projectId={project} snapshot={snapshot}>
  <StandaloneList projectId={project} index={snapshot.index} summaries={summaries} taskIds={[single.id]} allTaskIds={[single.id]} onSelectTask={noop} />
  <GoalList projectId={project} index={snapshot.index} summaries={summaries} goals={[summaries.get(goal.id)!]} total={1} workerMachines={snapshot.workerMachines} openGraphTarget={null} onOpenGoal={noop} onOpenGoalGraph={noop} onOpenGoalGraphTask={noop} onOpenListTask={noop} onOpenListChain={noop} onCloseChain={noop} onOpenTask={noop} />
</TaskExecutionClockProvider></TaskPauseProvider>;

it('shows each item’s own tags and updates them without remounting an expanded Goal or losing focus', () => {
  const rendered = renderWithLocale(view(), { locale: 'en', taskCache: true });
  const singleRow = document.getElementById(`standalone-task-${single.id}`)!;
  expect(singleRow).toHaveTextContent('Single tag');
  const card = document.querySelector<HTMLElement>(`[data-goal-id="${goal.id}"]`)!;
  const toggle = card.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
  expect(toggle).toHaveAccessibleDescription(/Goal tag/);
  fireEvent.click(toggle);
  const childRow = card.querySelector<HTMLElement>(`.goal-task-main[id$="-${child.id}"]`)!;
  const chainRow = card.querySelector<HTMLElement>(`.goal-task-main[id$="-${chain.id}"]`)!;
  expect(childRow).toHaveTextContent('Child tag');
  expect(chainRow).toHaveTextContent('Chain tag');
  expect(childRow).not.toHaveTextContent('Goal tag');
  childRow.focus();
  const summaries = new Map(snapshot.summaries);
  summaries.set(child.id, { ...summaries.get(child.id)!, version: 2n, tags: [tag(12, 'Renamed child'), tag(14, 'Another')] });
  summaries.set(goal.id, { ...summaries.get(goal.id)!, version: 2n, tags: [] });
  rendered.rerender(view(summaries));
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(childRow).toHaveFocus();
  expect(childRow).toHaveTextContent('Renamed child');
  expect(childRow).toHaveTextContent('Another');
  expect(childRow).not.toHaveTextContent('Child tag');
  expect(toggle).not.toHaveAttribute('aria-describedby', expect.stringContaining(`project-goal-tags-${goal.id}`));
  expect(card.querySelector('.goal-list-summary .task-tag-list')).toBeNull();
  expect(singleRow).toHaveTextContent('Single tag');
});

it('omits empty tag markup in both languages and selects the newest same-task tag data', () => {
  const rendered = renderWithLocale(<TaskTagList tags={[]} />, { locale: 'en' });
  expect(rendered.container).toBeEmptyDOMElement();
  rendered.setLocale('zh-CN');
  expect(rendered.container).toBeEmptyDOMElement();
  const summary = snapshot.summaries.get(child.id)!;
  expect(currentTaskTags(child, { ...summary, version: child.version + 1n, tags: [tag(12, 'New')] })).toEqual([tag(12, 'New')]);
  expect(currentTaskTags(child, { ...summary, version: child.version + 1n, tags: [] })).toEqual([]);
  expect(currentTaskTags(child, { ...summary, id: goal.id, version: child.version + 1n })).toEqual(child.tags);
  expect(currentTaskTags(child, { ...summary, version: child.version - 1n, tags: [] })).toEqual(child.tags);
  expect(currentTaskTags(child, undefined)).toEqual(child.tags);
});
