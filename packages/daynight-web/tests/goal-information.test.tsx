import { act, fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GoalInformation } from '../src/features/goal-detail/GoalInformation';
import { TaskDetailNotifications } from '../src/features/task-detail/TaskDetailNotice';
import { projectTaskScope } from '../src/features/task-graph/scope';
import { getFormats } from '../src/i18n/formats';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';

const projectId = '10000000-0000-4000-8000-000000000001';
const id = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const goal = detailFixture(projectId, id(1), { type: 'goal', createdAt: '2026-11-10T08:09:10Z', updatedAt: '2026-11-12T11:12:13Z' });
const scoped = () => {
  const outside = detailFixture(projectId, id(2), { status: 'done' });
  const chainMember = detailFixture(projectId, id(3), { parentId: goal.id, status: 'done', dependsOn: [outside.id] });
  const single = detailFixture(projectId, id(4), { parentId: goal.id, status: 'cancelled', dependsOn: [outside.id], externalDependsOn: [outside.id] });
  const unfinished = detailFixture(projectId, id(5), { parentId: goal.id, status: 'in_progress' });
  const unrelated = detailFixture(projectId, id(6), { status: 'done' });
  return projectTaskScope(snapshotFixture([goal, outside, chainMember, single, unfinished, unrelated]).index, goal.id);
};
const value = (region: HTMLElement, label: string) => within(region).getByText(label, { selector: 'dt' }).nextElementSibling!;
const information = (detail = goal) => <TaskDetailNotifications fallbackFocus={{ current: null }}><GoalInformation detail={detail} scope={scoped()} onRefreshGraph={vi.fn()} /></TaskDetailNotifications>;

it('shows exact Goal timestamps and counts only its children after complete graph classification', () => {
  renderWithLocale(<GoalInformation detail={goal} scope={scoped()} onRefreshGraph={vi.fn()} />, { locale: 'en' });
  const region = screen.getByRole('complementary', { name: 'Goal information' });
  expect(region.querySelector('dt')).toHaveTextContent('Goal ID');
  expect(value(region, 'Goal ID')).toHaveTextContent(goal.id);
  expect(value(region, 'Standalone tasks')).toHaveTextContent('2');
  expect(value(region, 'Task chains')).toHaveTextContent('1');
  expect(value(region, 'Total tasks')).toHaveTextContent('3');
  expect(value(region, 'Completed')).toHaveTextContent('1');
  expect(value(region, 'Cancelled')).toHaveTextContent('1');
  expect(value(region, 'Unfinished')).toHaveTextContent('1');
  const timestamps = region.querySelectorAll('time');
  expect(timestamps).toHaveLength(2);
  expect(timestamps[0]).toHaveAttribute('datetime', goal.createdAt);
  expect(timestamps[0]).toHaveTextContent(getFormats('en').dateTime(goal.createdAt));
  expect(timestamps[1]).toHaveAttribute('datetime', goal.updatedAt);
  expect(region.querySelector('.goal-information-progress')).toHaveTextContent('1/2 completed');
  expect(region.querySelectorAll('.goal-information-track i')).toHaveLength(1);
  expect(region.querySelector('.goal-information-track i')).toHaveStyle({ width: '50%' });
});

it('distinguishes an unavailable graph from a known empty Goal and exposes retry failures', () => {
  const retry = vi.fn();
  const view = renderWithLocale(<GoalInformation detail={goal} scope={null} onRefreshGraph={retry} />, { locale: 'en' });
  const region = screen.getByRole('complementary', { name: 'Goal information' });
  expect(within(region).getByRole('status')).toBeVisible();
  expect(within(region).getByRole('button', { name: 'Copy Goal ID' })).toBeEnabled();
  expect(within(region).queryByText('Total tasks')).toBeNull();
  expect(region.querySelector('time')).toHaveAttribute('datetime', goal.createdAt);
  view.rerender(<GoalInformation detail={goal} scope={null} graphError={new Error('Unavailable')} onRefreshGraph={retry} />);
  expect(within(region).getByRole('button', { name: 'Copy Goal ID' })).toBeEnabled();
  fireEvent.click(within(region).getByRole('button', { name: 'Retry refresh' }));
  expect(retry).toHaveBeenCalledOnce();
  const empty = projectTaskScope(snapshotFixture([goal]).index, goal.id);
  view.rerender(<GoalInformation detail={goal} scope={empty} onRefreshGraph={retry} />);
  expect(within(region).queryByRole('status')).toBeNull();
  expect(within(region).getByRole('button', { name: 'Copy Goal ID' })).toBeEnabled();
  expect(value(region, 'Standalone tasks')).toHaveTextContent('0');
  expect(value(region, 'Task chains')).toHaveTextContent('0');
  expect(value(region, 'Total tasks')).toHaveTextContent('0');
  expect(value(region, 'Unfinished')).toHaveTextContent('0');
  expect(region.querySelector('.goal-information-progress')).toHaveTextContent('0/0 completed');
  expect(region.querySelector('.goal-information-track i')).toHaveStyle({ width: '0%' });
});

it('retains observed statistics on a refresh failure and updates facts and language in place', () => {
  const retry = vi.fn();
  const scope = scoped();
  const view = renderWithLocale(<GoalInformation detail={goal} scope={scope} onRefreshGraph={retry} />, { locale: 'en' });
  const region = screen.getByRole('complementary', { name: 'Goal information' });
  view.rerender(<GoalInformation detail={goal} scope={scope} graphError={new Error('Offline')} onRefreshGraph={retry} />);
  expect(value(region, 'Total tasks')).toHaveTextContent('3');
  expect(within(region).getByRole('alert')).toBeVisible();
  fireEvent.click(within(region).getByRole('button', { name: 'Retry refresh' }));
  expect(retry).toHaveBeenCalledOnce();
  view.setLocale('zh-CN');
  expect(screen.getByRole('complementary', { name: 'Goal 信息' })).toBe(region);
  expect(value(region, '独立任务数')).toHaveTextContent('2');
  expect(value(region, '任务链数')).toHaveTextContent('1');
  const updated = { ...goal, updatedAt: '2026-11-12T12:13:14Z' };
  view.rerender(<GoalInformation detail={updated} scope={{ ...scope, progress: { total: 3, done: 2, cancelled: 1, unfinished: 0 } }} onRefreshGraph={retry} />);
  expect(value(region, '已完成')).toHaveTextContent('2');
  expect(value(region, '未结束')).toHaveTextContent('0');
  expect(region.querySelector('.goal-information-progress')).toHaveTextContent('2/2 已完成');
  expect(region.querySelectorAll('time')[1]).toHaveAttribute('datetime', updated.updatedAt);
  expect(region.querySelectorAll('time')[1]).toHaveTextContent(getFormats('zh-CN').dateTime(updated.updatedAt));
  expect(within(region).queryByRole('alert')).toBeNull();
});

it('copies the exact full Goal ID through its notification host and translates the action and result', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const view = renderWithLocale(information(), { locale: 'en' });
  const region = screen.getByRole('complementary', { name: 'Goal information' });
  const copy = within(region).getByRole('button', { name: 'Copy Goal ID' });
  expect(copy).toHaveAttribute('title', 'Copy Goal ID');
  fireEvent.click(copy);
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent('Copied');
  expect(notice.closest('.task-detail-notifications')).not.toBeNull();
  expect(region).not.toContainElement(notice);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(goal.id);
  view.setLocale('zh-CN');
  expect(screen.getByRole('button', { name: '复制 Goal ID' })).toHaveAttribute('title', '复制 Goal ID');
  expect(notice).toHaveTextContent('已复制');
  expect(writeText).toHaveBeenCalledOnce();
});

it('keeps the ID readable on rejection and replaces failure feedback after a successful retry', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError')).mockResolvedValueOnce(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  renderWithLocale(information(), { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy Goal ID' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy the Goal ID. Select and copy it manually.');
  expect(screen.getByText(goal.id)).toBeVisible();
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Goal ID' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(writeText).toHaveBeenNthCalledWith(2, goal.id);
});

it('reports unavailable clipboard access with Goal-specific Chinese feedback', async () => {
  vi.stubGlobal('navigator', {});
  renderWithLocale(information(), { locale: 'zh-CN' });
  fireEvent.click(screen.getByRole('button', { name: '复制 Goal ID' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法复制 Goal ID，请选中并手动复制。');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText(goal.id)).toBeVisible();
});

it('disables repeated pending copies and isolates late results after switching Goal identity', async () => {
  let resolve!: () => void;
  const writeText = vi.fn().mockReturnValueOnce(new Promise<void>((done) => { resolve = done; })).mockResolvedValueOnce(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const view = renderWithLocale(information(), { locale: 'en' });
  const copy = screen.getByRole('button', { name: 'Copy Goal ID' });
  fireEvent.click(copy); fireEvent.click(copy);
  expect(copy).toBeDisabled();
  expect(writeText).toHaveBeenCalledOnce();
  const next = { ...goal, id: id(9) };
  view.rerender(information(next));
  await act(async () => resolve());
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(next.id)).toBeVisible();
  const nextCopy = screen.getByRole('button', { name: 'Copy Goal ID' });
  expect(nextCopy).toBeEnabled();
  fireEvent.click(nextCopy);
  expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  expect(writeText).toHaveBeenNthCalledWith(2, next.id);
});
