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
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: ({ value, onChange }: { value: readonly { id: string; name: string }[]; onChange: (value: readonly { id: string; name: string }[]) => void }) => <input aria-label="Tag draft" value={value[0]?.name ?? ''} onChange={(event) => onChange([{ id: '30000000-0000-4000-8000-000000000001', name: event.currentTarget.value }])} /> }));

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const noop = () => {};
let root: HTMLDivElement;
beforeEach(() => { root = document.createElement('div'); root.id = 'root'; document.body.append(root); select.mockClear(); });
afterEach(() => root.remove());

const surface = (description: string, presentation: 'dialog' | 'page' = 'dialog', resourceUnavailable = false, detailError: unknown = null, historyGeneration = 1) => {
  const detail = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', description });
  const task = { detail, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null }, historyGeneration,
    canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
    canDisplayDelete: false, canDelete: false, canSetTags: true, setTags: noop, reconcile: noop, assignmentUncertain: false } as unknown as ReturnType<typeof useTaskDetail>;
  return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={detail} resourceState={task} snapshot={null} presentation={presentation}
    fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onClose={noop} onRefreshGraph={noop} resourceUnavailable={resourceUnavailable} detailError={detailError} />;
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
  expect(within(panel).getByRole('heading', { name: 'Goal text' }).closest('.description-card')).not.toBeNull();
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
  expect(screen.getByRole('tabpanel', { name: '描述' }).querySelector('.description-card')).toBeNull();
});

it('retains a tag draft through a background failure but retires it when Goal access is lost', () => {
  const view = renderWithLocale(surface('Goal'), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Tag draft' }), { target: { value: 'Unsubmitted' } });
  view.rerender(surface('Goal', 'dialog', false, new Error('Temporary refresh failure')));
  expect(screen.getByRole('textbox', { name: 'Tag draft' })).toHaveValue('Unsubmitted');
  view.rerender(surface('Goal', 'dialog', true));
  expect(screen.queryByRole('textbox', { name: 'Tag draft', hidden: true })).toBeNull();
  view.rerender(surface('Goal'));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
  expect(screen.getByRole('textbox', { name: 'Tag draft' })).toHaveValue('');
});

it('does not carry a Goal tag draft into a new history generation', () => {
  const view = renderWithLocale(surface('Goal'), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Tag draft' }), { target: { value: 'Old draft' } });
  view.rerender(surface('Goal', 'dialog', false, null, 2));
  expect(screen.queryByRole('textbox', { name: 'Tag draft' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
  expect(screen.getByRole('textbox', { name: 'Tag draft' })).toHaveValue('');
});
