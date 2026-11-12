import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import type { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { detailFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';

const select = vi.hoisted(() => vi.fn());
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select }) }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: ({ reveal }: { reveal: { path: string | null } }) => <span>Attachment: {reveal.path}</span> }));
vi.mock('../src/features/task-thread/TaskDiscussion', () => ({ TaskDiscussion: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeSelect', () => ({ TaskAssigneeSelect: () => null }));

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const noop = () => {};
let root: HTMLDivElement;
beforeEach(() => { root = document.createElement('div'); root.id = 'root'; document.body.append(root); select.mockClear(); });
afterEach(() => root.remove());

const surface = (description: string, presentation: 'dialog' | 'page' = 'dialog') => {
  const detail = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', description });
  const task = { detail, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null }, historyGeneration: 1,
    canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
    canDisplayDelete: false, canDelete: false, assignmentUncertain: false } as unknown as ReturnType<typeof useTaskDetail>;
  return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={detail} resourceState={task} snapshot={null} presentation={presentation}
    fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onClose={noop} onRefreshGraph={noop} />;
};

it.each(['dialog', 'page'] as const)('keeps description and information with keyboard tabs and attachment navigation in %s', (presentation) => {
  renderWithLocale(surface('# Goal text\n\n[Guide](docs/guide.md)\n\n![Diagram](images/diagram.png)', presentation), { locale: 'en', taskCache: true, container: root });
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map(tab => tab.textContent)).toEqual(['Description', 'Attachments', 'Discussion']);
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab', { name: 'Tasks' })).toBeNull();
  expect(screen.getByRole('complementary', { name: 'Goal information' })).toBeVisible();
  fireEvent.keyDown(tabs[1]!, { key: 'Home' });
  expect(tabs[0]).toHaveFocus();
  expect(tabs[0]).toHaveAttribute('tabindex', '0');
  const panel = screen.getByRole('tabpanel', { name: 'Description' });
  expect(panel.id).toBe(tabs[0]!.getAttribute('aria-controls'));
  expect(within(panel).getByRole('heading', { name: 'Goal text' })).toBeVisible();
  expect(within(panel).getByRole('img', { name: 'Diagram' })).toHaveAttribute('src', expect.stringContaining('/images/diagram.png'));
  fireEvent.click(within(panel).getByRole('link', { name: 'Guide' }));
  expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  expect(select).toHaveBeenCalledWith('docs/guide.md');
  expect(screen.getByText('Attachment: docs/guide.md')).toBeVisible();
  fireEvent.keyDown(tabs[1]!, { key: 'End' });
  expect(tabs[2]).toHaveFocus();
  fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
  expect(tabs[0]).toHaveFocus();
});

it('shows the localized empty description in its own panel', () => {
  renderWithLocale(surface(''), { locale: 'zh-CN', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('tab', { name: '描述' }));
  expect(screen.getByRole('tabpanel', { name: '描述' })).toHaveTextContent('暂无描述');
});
