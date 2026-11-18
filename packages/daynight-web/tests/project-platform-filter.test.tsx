import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPerson } from '../src/api/auth-types';
import type { TaskDetail } from '../src/api/types';
import * as tagApi from '../src/api/task-tags';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { selectStatus } from './helpers/statusFilter';
import { TEST_VIEWER_ID, taskSyncQuery, taskSyncResponse } from './helpers/taskSync';

const projectId = '00000000-0000-4000-8000-000000000100';
const otherUser = '00000000-0000-4000-8000-000000000202';
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const task = (value: number, changes: Partial<TaskDetail> = {}) => detailFixture(projectId, id(value), { assignedTo: TEST_VIEWER_ID, title: `Task ${value}`, ...changes });
const people: readonly ProjectPerson[] = [
  { version: 'a'.repeat(64), userId: TEST_VIEWER_ID, name: 'Current person', avatarUrl: null, hasProjectAccess: true },
  { version: 'a'.repeat(64), userId: otherUser, name: 'Other person', avatarUrl: null, hasProjectAccess: true },
];
const render = createLocaleRender('zh-CN');

beforeEach(() => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

const install = (initial: readonly TaskDetail[]) => {
  const tasks = new Map(initial.map(value => [value.id, value]));
  const fetcher = vi.fn(async (address: string, options?: RequestInit): Promise<Response> => {
    const url = new URL(address, location.origin);
    if (url.pathname === `/api/v1/projects/${projectId}/task-sync`) return taskSyncResponse(graphFixture([...tasks.values()]), {
      assigneeVersions: people.map(({ userId, version, hasProjectAccess }) => ({ userId, version, hasProjectAccess })),
      viewerId: TEST_VIEWER_ID, query: taskSyncQuery(url), versionForTask: value => tasks.get(value.id)!.version,
      propertiesForTask: value => tasks.get(value.id)!.properties, tagsForTask: value => tasks.get(value.id)!.tags,
    });
    if (url.pathname === `/api/v1/projects/${projectId}/task-assignees`) {
      const requested = url.searchParams.getAll('userId');
      return resourceResponse({ items: people.filter(person => requested.length === 0 || requested.includes(person.userId)), unresolvedUserIds: requested.filter(userId => !people.some(person => person.userId === userId)) }, TEST_VIEWER_ID);
    }
    const match = new RegExp(`^/api/v1/projects/${projectId}/tasks/([^/]+)$`).exec(url.pathname);
    if (match !== null && tasks.has(match[1]!)) return resourceResponse(tasks.get(match[1]!)!, TEST_VIEWER_ID);
    throw new Error(`Unexpected request ${options?.method ?? 'GET'} ${address}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
const mount = async () => {
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const view = render(<ProjectPage projectId={projectId} />, { container: root, taskCache: true });
  fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
  await screen.findByRole('combobox', { name: '平台' });
  return view;
};
const platform = (value: string) => fireEvent.change(screen.getByRole('combobox', { name: '平台' }), { target: { value } });
const chains = () => screen.getByRole('tab', { name: '任务链' });
const standalone = () => screen.getByRole('tab', { name: '独立任务' });
const row = (value: number) => document.getElementById(`standalone-task-${id(value)}`);
const chain = (value: number) => document.getElementById(`task-root-${id(value)}`);
const pagination = (name: string) => screen.getByRole('navigation', { name: `${name}分页` });

describe('project platform filtering', () => {
  it('uses five exact values, keeps both tabs and Goal totals, and performs no business writes', async () => {
    const fetcher = install([
      task(1), task(2, { requiredPlatform: 'linux' }), task(3, { requiredPlatform: 'windows' }), task(4, { requiredPlatform: 'macos' }),
      task(11), task(12, { dependsOn: [id(11)], requiredPlatform: 'linux' }),
      task(21, { requiredPlatform: 'windows' }), task(22, { dependsOn: [id(21)], requiredPlatform: 'macos' }),
      task(100, { type: 'goal' }),
    ]);
    const view = await mount();
    const select = screen.getByRole('combobox', { name: '平台' });
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['所有任务', '任何平台', 'Linux', 'Windows', 'macOS']);
    const cases: readonly [string, readonly number[], readonly number[]][] = [
      ['all', [1, 2, 3, 4], [11, 21]], ['any', [1], [11]], ['linux', [2], [11]],
      ['windows', [3], [21]], ['macos', [4], [21]],
    ];
    for (const [value, expectedRows, expectedChains] of cases) {
      platform(value);
      for (const n of [11, 21]) expect(chain(n) !== null).toBe(expectedChains.includes(n));
      fireEvent.click(standalone());
      for (const n of [1, 2, 3, 4]) expect(row(n) !== null).toBe(expectedRows.includes(n));
      fireEvent.click(chains());
      expect(select).toHaveValue(value);
      expect(screen.getByRole('tab', { name: 'Goal' }).querySelector('.graph-count-pill')).toHaveTextContent('1');
    }
    view.setLocale('en');
    const english = screen.getByRole('combobox', { name: 'Platform' });
    expect(within(english).getAllByRole('option').map(option => option.textContent)).toEqual(['All tasks', 'Any platform', 'Linux', 'Windows', 'macOS']);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method !== undefined && options.method !== 'GET')).toHaveLength(0);
  });

  it('requires all conditions on one scoped member and retains the complete chain and progress', async () => {
    install([
      task(1, { requiredPlatform: 'windows', status: 'done' }),
      task(2, { dependsOn: [id(1)], requiredPlatform: 'linux', status: 'todo' }),
      task(3, { dependsOn: [id(1)], assignedTo: otherUser, requiredPlatform: 'macos' }),
      task(4, { requiredPlatform: 'linux', assignedTo: otherUser }),
      task(5, { dependsOn: [id(4)], requiredPlatform: 'windows' }),
      task(6, { requiredPlatform: 'linux' }),
      task(7, { dependsOn: [id(4), id(6)], externalDependsOn: [id(6)], requiredPlatform: 'windows' }),
    ]);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /^负责人:/ }));
    fireEvent.click(await screen.findByRole('option', { name: '分配给我' }));
    selectStatus('todo'); platform('linux');
    expect(chain(1)).toBeVisible(); expect(chain(4)).toBeNull();
    expect(chain(1)!.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('1/3 已完成');
    fireEvent.click(chain(1)!);
    const children = document.getElementById(`goal-children-${id(1)}`)!;
    expect(children).toHaveTextContent('Task 2'); expect(children).toHaveTextContent('Task 3');
    fireEvent.click(standalone()); expect(row(6)).toBeVisible();
  });

  it('resets both ordinary pages and restores empty results without resetting the Goal page', async () => {
    install(Array.from({ length: 41 }, (_, position) => {
      const root = position * 2 + 1;
      return [task(root, { requiredPlatform: 'linux' }), task(root + 1, { dependsOn: [id(root)] }), task(1000 + position, { requiredPlatform: 'linux' }), task(2000 + position, { type: 'goal' })];
    }).flat());
    await mount();
    fireEvent.click(within(pagination('任务链列表')).getByRole('button', { name: '下一页' }));
    fireEvent.click(standalone());
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Goal' }));
    fireEvent.click(within(pagination('Goal')).getByRole('button', { name: '下一页' }));
    fireEvent.click(standalone()); platform('linux');
    expect(pagination('独立任务列表')).toHaveTextContent('第 1 / 3 页');
    fireEvent.click(chains()); expect(pagination('任务链列表')).toHaveTextContent('第 1 / 3 页');
    fireEvent.click(screen.getByRole('tab', { name: 'Goal' }));
    expect(pagination('Goal')).toHaveTextContent('第 2 / 3 页');
    expect(screen.queryByRole('combobox', { name: '平台' })).toBeNull();
    fireEvent.click(standalone()); platform('windows');
    expect(screen.getByRole('heading', { name: '没有匹配筛选条件的任务' })).toBeVisible();
    platform('all'); expect(row(1040)).toBeVisible();
  });

  it('clears only a blocking platform when navigating from overview and preserves a matching selection', async () => {
    install([task(1, { requiredPlatform: 'linux' }), task(2, { dependsOn: [id(1)], requiredPlatform: 'windows' })]);
    await mount(); platform('linux');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(screen.getByRole('combobox', { name: '平台' })).toHaveValue('linux');
    platform('macos');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(screen.getByRole('combobox', { name: '平台' })).toHaveValue('all');
  });

  it('does not apply an obsolete overview tag check after a new platform selection', async () => {
    const tag = { id: id(900), name: 'backend' };
    const timestamp = '2026-10-22T10:00:00Z';
    vi.spyOn(tagApi, 'listProjectTags').mockResolvedValue({ items: [{ ...tag, projectId, version: 1n, createdAt: timestamp, updatedAt: timestamp, usage: { tasks: 1, goals: 0 } }], catalogEpoch: id(901), nextCursor: null });
    let release!: (value: readonly typeof tag[]) => void;
    const pending = new Promise<readonly typeof tag[]>(resolve => { release = resolve; });
    let waiting = false, checkSignal: AbortSignal | undefined;
    const resolveTags = vi.spyOn(tagApi, 'resolveProjectTags').mockImplementation(async (_project, _ids, signal) => {
      if (waiting) { checkSignal = signal; return pending; }
      return [tag];
    });
    install([task(1, { requiredPlatform: 'linux' }), task(2, { requiredPlatform: 'linux', dependsOn: [id(1)] }), task(3, { requiredPlatform: 'macos', tags: [tag] })]);
    await mount(); platform('windows');
    fireEvent.click(screen.getByText('标签筛选', { selector: 'summary > span:first-child' }).closest('summary')!);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'backend' }));
    await waitFor(() => expect(resolveTags).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    waiting = true;
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(checkSignal).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
    platform('macos');
    expect(checkSignal!.aborted).toBe(true);
    await act(async () => { release([tag]); await pending; });
    expect(screen.getByRole('combobox', { name: '平台' })).toHaveValue('macos');
    expect(screen.getByRole('button', { name: '移除 backend' })).toBeVisible();
    expect(chain(1)).toBeNull();
    fireEvent.click(standalone()); expect(row(3)).toBeVisible();
  });

  it('requires platform and tag to match the same chain member', async () => {
    const tag = { id: id(900), name: 'backend' };
    install([task(1, { requiredPlatform: 'linux', tags: [tag] }), task(2, { requiredPlatform: 'windows', dependsOn: [id(1)] })]);
    await mount(); platform('linux');
    fireEvent.click(screen.getByText('标签筛选', { selector: 'summary > span:first-child' }).closest('summary')!);
    fireEvent.click(screen.getByRole('checkbox', { name: '仅无标签' }));
    expect(chain(1)).toBeNull();
    platform('windows'); expect(chain(1)).toBeVisible();
  });

  it('retains the platform when a tag alone blocks an explicitly located task', async () => {
    const tag = { id: id(900), name: 'backend' };
    install([task(1, { requiredPlatform: 'linux', tags: [tag] }), task(2, { requiredPlatform: 'linux' })]);
    await mount(); fireEvent.click(standalone()); platform('linux');
    fireEvent.click(screen.getByText('标签筛选', { selector: 'summary > span:first-child' }).closest('summary')!);
    fireEvent.click(screen.getByRole('checkbox', { name: '仅无标签' }));
    expect(row(1)).toBeNull(); expect(row(2)).toBeVisible();
    act(() => { history.pushState({ foreign: true }, '', `/projects/${projectId}?tab=tasks#task=${id(1)}`); dispatchEvent(new PopStateEvent('popstate')); });
    await waitFor(() => expect(location.hash).toBe(''));
    expect(screen.getByRole('combobox', { name: '平台' })).toHaveValue('linux');
    expect(row(1)).toBeNull(); expect(row(2)).toBeVisible();
  });

  it('clears a blocking platform for explicit task location and defaults after remount', async () => {
    install([task(1, { requiredPlatform: 'linux' }), task(2, { requiredPlatform: 'windows' })]);
    const view = await mount(); fireEvent.click(standalone()); platform('windows');
    expect(row(1)).toBeNull();
    act(() => { history.pushState({ foreign: true }, '', `/projects/${projectId}?tab=tasks#task=${id(1)}`); dispatchEvent(new PopStateEvent('popstate')); });
    await waitFor(() => expect(row(1)).toHaveFocus());
    expect(screen.getByRole('combobox', { name: '平台' })).toHaveValue('all');
    platform('linux'); view.unmount(); view.container.remove();
    await mount(); expect(screen.getByRole('combobox', { name: '平台' })).toHaveValue('all');
  });
});
