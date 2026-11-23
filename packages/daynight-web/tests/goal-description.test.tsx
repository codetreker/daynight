import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import type { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { detailFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';

const select = vi.hoisted(() => vi.fn());
vi.mock('../src/features/goal-detail/useGoalDependencies', () => ({ useGoalDependencies: () => ({ page: null, unavailable: false, error: null, pending: false, hasPrevious: false, refresh: () => {}, next: () => {}, previous: () => {} }) }));
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

const surface = (description: string, presentation: 'dialog' | 'page' = 'dialog', resourceUnavailable = false, detailError: unknown = null, historyGeneration = 1, reconciliationError: unknown = null, requiresFreshRead = false) => {
  const detail = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', description });
  const task = { detail, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError }, historyGeneration, status: 'ready', refreshing: false, requiresFreshRead,
    canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
    canDisplayDelete: false, canDelete: false, canSetTags: true, setTags: noop, reconcile: noop, assignmentUncertain: false } as unknown as ReturnType<typeof useTaskDetail>;
  return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={detail} resourceState={task} snapshot={null} presentation={presentation}
    fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onClose={noop} onRefreshGraph={noop} resourceUnavailable={resourceUnavailable} detailError={detailError} />;
};

it.each(['dialog', 'page'] as const)('keeps description and information with keyboard tabs and attachment navigation in %s', (presentation) => {
  renderWithLocale(surface('# Goal text\n\n[Guide](docs/guide.md)\n\n![Diagram](images/diagram.png)', presentation), { locale: 'en', taskCache: true, container: root });
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map(tab => tab.textContent)).toEqual(['Description', 'Attachments', 'Discussion', 'Usage']);
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
  expect(tabs[3]).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'Usage' })).toBeVisible();
  fireEvent.keyDown(tabs[3]!, { key: 'ArrowRight' });
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


it('copies the readable Goal default URL and retires pending feedback on access loss or a new generation', async () => {
  const pending = Promise.withResolvers<void>();
  const write = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const view = renderWithLocale(surface(''), { locale: 'en', taskCache: true, container: root });
  const trigger = screen.getByRole('button', { name: 'More Goal actions' });
  expect(screen.getByRole('button', { name: /^Edit$/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
  fireEvent.click(trigger);
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
  expect(write).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/projects/${projectId}/tasks/${goalId}`);
  expect(trigger).toHaveFocus();
  view.rerender(surface('', 'dialog', false, new Error('Temporary refresh failure')));
  expect(screen.getByRole('button', { name: 'More Goal actions' })).toBe(trigger);
  view.rerender(surface('', 'dialog', true));
  expect(screen.queryByRole('button', { name: 'More Goal actions' })).toBeNull();
  view.rerender(surface('', 'dialog', false, null, 2));
  await act(async () => pending.resolve());
  expect(screen.queryByText('Link copied')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More Goal actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
  expect(await screen.findByText('Link copied')).toBeVisible();
  vi.unstubAllGlobals();
});


it('retires the copy action after reconciliation confirms lost access until a fresh read', async () => {
  const pending = Promise.withResolvers<void>();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockReturnValue(pending.promise) } });
  const view = renderWithLocale(surface('Goal'), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: 'More Goal actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
  const denied = new ApiError('server', 403, 'forbidden', 'request');
  view.rerender(surface('Goal', 'dialog', false, null, 1, denied, true));
  expect(screen.queryByRole('button', { name: 'More Goal actions' })).toBeNull();
  view.rerender(surface('Goal', 'dialog', false, null, 1, null, true));
  expect(screen.queryByRole('button', { name: 'More Goal actions' })).toBeNull();
  await act(async () => pending.resolve());
  expect(screen.queryByText('Link copied')).toBeNull();
  view.rerender(surface('Goal'));
  expect(screen.getByRole('button', { name: 'More Goal actions' })).toBeVisible();
  vi.unstubAllGlobals();
});
