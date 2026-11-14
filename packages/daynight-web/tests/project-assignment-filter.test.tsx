import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPerson } from '../src/api/auth-types';
import type { TaskDetail } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { TEST_VIEWER_ID, taskSyncQuery, taskSyncResponse } from './helpers/taskSync';

const projectId = '00000000-0000-4000-8000-000000000100';
const otherUser = '00000000-0000-4000-8000-000000000202';
const formerUser = '00000000-0000-4000-8000-000000000203';
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const task = (value: number, assignedTo: string | null, changes: Partial<TaskDetail> = {}) => detailFixture(projectId, id(value), { assignedTo, title: `Task ${value}`, ...changes });
const people: readonly ProjectPerson[] = [
  { version: "a".repeat(64), userId: TEST_VIEWER_ID, name: 'Current person', avatarUrl: null, hasProjectAccess: true },
  { version: "a".repeat(64), userId: otherUser, name: 'Other person', avatarUrl: null, hasProjectAccess: true },
  { version: "a".repeat(64), userId: formerUser, name: 'Former person', avatarUrl: null, hasProjectAccess: false },
];
const render = createLocaleRender('zh-CN');

beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${projectId}`);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

const install = (initial: readonly TaskDetail[]) => {
  const tasks = new Map(initial.map((value) => [value.id, value]));
  const fetcher = vi.fn(async (address: string, options?: RequestInit): Promise<Response> => {
    const url = new URL(address, location.origin);
    if (url.pathname === `/api/v1/projects/${projectId}/task-sync`) return taskSyncResponse(graphFixture([...tasks.values()]), {
      assigneeVersions: people.map(({ userId, version, hasProjectAccess }) => ({ userId, version, hasProjectAccess })),
      viewerId: TEST_VIEWER_ID, query: taskSyncQuery(url), versionForTask: (value) => tasks.get(value.id)!.version,
      propertiesForTask: (value) => tasks.get(value.id)!.properties,
      tagsForTask: (value) => tasks.get(value.id)!.tags,
    });
    if (url.pathname === `/api/v1/projects/${projectId}/task-assignees`) {
      const requested = url.searchParams.getAll('userId');
      return resourceResponse({ items: people.filter((person) => requested.length === 0 || requested.includes(person.userId)), unresolvedUserIds: requested.filter((userId) => !people.some((person) => person.userId === userId)) }, TEST_VIEWER_ID);
    }
    const match = new RegExp(`^/api/v1/projects/${projectId}/tasks/([^/]+)$`).exec(url.pathname);
    if (match !== null) {
      const previous = tasks.get(match[1]!)!;
      if (options?.method === 'PATCH') {
        const body = JSON.parse(String(options.body));
        expect(BigInt(body.version)).toBe(previous.version);
        const next = { ...previous, assignedTo: body.assignedTo as string | null, allowAgents: false, version: previous.version + 1n, updatedAt: '2026-10-22T10:01:00Z' };
        tasks.set(next.id, next);
        return resourceResponse(next, TEST_VIEWER_ID);
      }
      return resourceResponse(previous, TEST_VIEWER_ID);
    }
    if (url.pathname.endsWith('/attachments')) return resourceResponse({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${options?.method ?? 'GET'} ${address}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { tasks, fetcher };
};
const mount = async (findFilter = () => screen.findByRole('button', { name: /^负责人:/ })) => {
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const view = render(<ProjectPage projectId={projectId} />, { container: root, taskCache: true });
  fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
  await findFilter();
  return view;
};
const filter = async (label: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: /^负责人:/ }));
  fireEvent.click(await screen.findByRole('option', { name: label }));
};
const status = (value: string) => fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value } });
const chains = () => screen.getByRole('tab', { name: '任务链' });
const standalone = () => screen.getByRole('tab', { name: '独立任务' });
const goals = () => screen.getByRole('tab', { name: 'Goal' });
const expectCounts = (standaloneCount: number, chainCount: number, goalCount: number) => {
  for (const [tab, count] of [[standalone(), standaloneCount], [chains(), chainCount], [goals(), goalCount]] as const) {
    expect(tab.querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${count}$`));
  }
};
const row = (value: number) => document.getElementById(`standalone-task-${id(value)}`);
const chain = (value: number) => document.getElementById(`task-root-${id(value)}`);
const pagination = (name: string) => screen.getByRole('navigation', { name: `${name}分页` });

describe('project assignee filtering', () => {
  it.each([
    ['分配给我', { kind: 'me' }, [1]],
    ['未分配', { kind: 'unassigned' }, [2]],
    ['Former person', { kind: 'user', userId: formerUser }, [3]],
    ['所有负责人', { kind: 'all' }, [1, 2, 3]],
  ] as const)('restores %s before applying either list projection', async (label, saved, matching) => {
    install([
      task(1, TEST_VIEWER_ID), task(2, null), task(3, formerUser),
      task(11, TEST_VIEWER_ID), task(12, TEST_VIEWER_ID, { dependsOn: [id(11)] }),
      task(21, null), task(22, null, { dependsOn: [id(21)] }),
      task(31, formerUser), task(32, formerUser, { dependsOn: [id(31)] }),
      task(101, TEST_VIEWER_ID, { type: 'goal' }), task(102, null, { type: 'goal' }), task(103, formerUser, { type: 'goal' }),
      task(201, TEST_VIEWER_ID, { type: 'goal', status: 'done', completedAt: '2026-10-22T10:00:00Z' }),
      task(202, null, { type: 'goal', status: 'cancelled', cancelledAt: '2026-10-22T10:00:00Z' }),
      task(203, formerUser, { type: 'goal', status: 'done', completedAt: '2026-10-22T10:00:00Z' }),
    ]);
    const preference = `daynight:task-assignee-filter:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
    const matchingIds = new Set<number>(matching);
    localStorage.setItem(preference, JSON.stringify(saved));
    const view = await mount();
    await waitFor(() => expect(chain(matching[0]! * 10 + 1)).toBeVisible());
    await waitFor(() => expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent(label));
    expectCounts(matching.length, matching.length * 2, matching.length);
    for (const n of [1, 2, 3]) {
      if (matchingIds.has(n)) expect(chain(n * 10 + 1)).toBeVisible();
      else expect(chain(n * 10 + 1)).toBeNull();
    }
    fireEvent.click(standalone());
    for (const n of [1, 2, 3]) {
      if (matchingIds.has(n)) expect(row(n)).toBeVisible();
      else expect(row(n)).toBeNull();
    }
    view.unmount();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent(label));
    await waitFor(() => expect(row(matching[0]!)).toBeVisible());
    expectCounts(matching.length, matching.length * 2, matching.length);
    for (const n of [1, 2, 3]) if (!matchingIds.has(n)) expect(row(n)).toBeNull();
  });

  it('counts matching unfinished members and Goal owners independently of list status and scope', async () => {
    const finishedAt = '2026-10-22T10:00:00Z';
    install([
      task(1, TEST_VIEWER_ID, { status: 'proposed' }), task(2, null), task(3, formerUser, { status: 'in_progress', startedAt: finishedAt }),
      task(4, TEST_VIEWER_ID, { status: 'done', completedAt: finishedAt }), task(5, otherUser, { status: 'cancelled', cancelledAt: finishedAt }),
      task(6, TEST_VIEWER_ID, { dependsOn: [id(2)], externalDependsOn: [id(2)] }),
      task(11, TEST_VIEWER_ID, { status: 'done', completedAt: finishedAt }), task(12, otherUser, { dependsOn: [id(11)] }),
      task(13, TEST_VIEWER_ID, { status: 'proposed', dependsOn: [id(11)] }), task(14, null, { dependsOn: [id(11)] }),
      task(15, formerUser, { dependsOn: [id(12), id(13)] }),
      task(16, TEST_VIEWER_ID, { status: 'cancelled', cancelledAt: finishedAt, dependsOn: [id(15)] }),
      task(21, TEST_VIEWER_ID, { parentId: id(500) }), task(22, otherUser, { dependsOn: [id(21)] }),
      task(23, TEST_VIEWER_ID, { parentId: id(500) }),
      task(500, otherUser, { type: 'goal', status: 'done', completedAt: finishedAt }),
      task(501, TEST_VIEWER_ID, { type: 'goal', status: 'cancelled', cancelledAt: finishedAt }),
      task(502, null, { type: 'goal' }), task(503, formerUser, { type: 'goal', status: 'done', completedAt: finishedAt }),
    ]);
    await mount();
    expectCounts(4, 5, 1);
    await filter('分配给我');
    expectCounts(2, 1, 0);
    expect(chain(11)).toBeVisible();
    fireEvent.click(chain(11)!);
    expect(document.getElementById(`goal-children-${id(11)}`)!.querySelectorAll('.goal-task-row')).toHaveLength(5);
    status('todo');
    expect(chain(11)).toBeNull(); // The viewer's unfinished member is proposed, not todo.
    expectCounts(2, 1, 0);
    fireEvent.click(goals());
    expect(document.querySelector(`[data-goal-id="${id(500)}"]`)).toBeNull();
    expectCounts(2, 1, 0);
    status('all');
    expect(document.querySelector(`[data-goal-id="${id(501)}"]`)).toBeVisible();
    await filter('未分配'); expectCounts(1, 1, 1);
    await filter(/^Former person/); expectCounts(1, 1, 0);
    await filter('所有负责人'); expectCounts(4, 5, 1);
  });

  it('counts unfinished Goal owners independently of children and list status in both locales', async () => {
    const finishedAt = '2026-10-22T10:00:00Z';
    install([
      task(500, TEST_VIEWER_ID, { type: 'goal' }),
      task(501, TEST_VIEWER_ID, { type: 'goal', status: 'in_progress', startedAt: finishedAt }),
      task(502, TEST_VIEWER_ID, { type: 'goal', status: 'done', completedAt: finishedAt }),
      task(503, TEST_VIEWER_ID, { type: 'goal', status: 'cancelled', cancelledAt: finishedAt }),
      task(504, null, { type: 'goal' }), task(505, formerUser, { type: 'goal' }),
      task(506, otherUser, { type: 'goal', status: 'done', completedAt: finishedAt }),
      task(1, otherUser, { parentId: id(500), status: 'done', completedAt: finishedAt }),
      task(2, otherUser, { parentId: id(501), status: 'cancelled', cancelledAt: finishedAt }),
      task(3, TEST_VIEWER_ID, { parentId: id(506) }),
    ]);
    const view = await mount();
    await filter('分配给我');
    expect(goals().querySelector('.graph-count-pill')).toHaveTextContent(/^2$/);
    expect(goals().querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成 Goal 数');
    fireEvent.click(goals());
    status('done');
    expect(document.querySelector(`[data-goal-id="${id(502)}"]`)).toBeVisible();
    expect(goals().querySelector('.graph-count-pill')).toHaveTextContent(/^2$/);
    status('cancelled');
    expect(document.querySelector(`[data-goal-id="${id(503)}"]`)).toBeVisible();
    expect(goals().querySelector('.graph-count-pill')).toHaveTextContent(/^2$/);
    await filter('未分配'); expect(goals().querySelector('.graph-count-pill')).toHaveTextContent(/^1$/);
    await filter(/^Former person/); expect(goals().querySelector('.graph-count-pill')).toHaveTextContent(/^1$/);
    await filter('所有负责人'); expect(goals().querySelector('.graph-count-pill')).toHaveTextContent(/^4$/);
    view.setLocale('en');
    expect(screen.getByRole('tab', { name: 'Goals' }).querySelector('.graph-count-pill')).toHaveAttribute('title', 'Unfinished Goal count');
  });

  it('keeps the unfinished Goal count while filtering Goals and their children by tags', async () => {
    const tag = { id: id(900), name: 'backend' };
    install([
      task(500, TEST_VIEWER_ID, { type: 'goal', tags: [tag] }), task(501, TEST_VIEWER_ID, { type: 'goal' }),
      task(1, TEST_VIEWER_ID, { parentId: id(501), tags: [tag] }), task(2, TEST_VIEWER_ID, { parentId: id(501) }),
    ]);
    await mount(); fireEvent.click(goals());
    const count = () => goals().querySelector('.graph-count-pill');
    expect(count()).toHaveTextContent(/^2$/);
    fireEvent.click(screen.getByText('标签筛选', { selector: 'summary' }));
    const goalFilter = screen.getByText('标签筛选', { selector: 'summary' }).closest('.tag-filter')!;
    fireEvent.click(within(goalFilter as HTMLElement).getByRole('checkbox', { name: '无标签' }));
    expect(document.querySelector(`[data-goal-id="${id(500)}"]`)).toBeNull();
    const card = document.querySelector<HTMLElement>(`[data-goal-id="${id(501)}"]`)!;
    expect(card).toBeVisible(); expect(count()).toHaveTextContent(/^2$/);
    fireEvent.click(card.querySelector('.goal-list-toggle')!);
    expect(card.querySelectorAll('.goal-task-main')).toHaveLength(2);
    fireEvent.click(screen.getByText('子 Task 标签筛选', { selector: 'summary' }));
    const childFilter = screen.getByText('子 Task 标签筛选', { selector: 'summary' }).closest('.tag-filter')!;
    fireEvent.click(within(childFilter as HTMLElement).getByRole('checkbox', { name: '无标签' }));
    expect(card.querySelectorAll('.goal-task-main')).toHaveLength(1);
    expect(card).toHaveTextContent('Task 2');
    expect(count()).toHaveTextContent(/^2$/);
  });

  it.each([
    ['分配给我', { kind: 'me' }], ['未分配', { kind: 'unassigned' }],
    ['Former person', { kind: 'user', userId: formerUser }], ['所有负责人', { kind: 'all' }],
  ] as const)('persists %s through the control and restores it on reopening', async (label, saved) => {
    install([task(1, TEST_VIEWER_ID), task(2, null), task(3, formerUser)]);
    const preference = `daynight:task-assignee-filter:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
    localStorage.setItem(preference, JSON.stringify(label === '所有负责人' ? { kind: 'unassigned' } : { kind: 'all' }));
    const view = await mount();
    await filter(label === 'Former person' ? /^Former person/ : label);
    expect(JSON.parse(localStorage.getItem(preference)!)).toEqual(saved);
    view.unmount(); view.container.remove();
    const reopened = await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent(label));
    reopened.unmount(); reopened.container.remove();
  });

  it('shows localized write failure while keeping the current list usable, and clears it after saving', async () => {
    install([task(1, TEST_VIEWER_ID), task(2, null)]);
    const preference = `daynight:task-assignee-filter:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
    localStorage.setItem(preference, JSON.stringify({ kind: 'unassigned' }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === preference) throw new DOMException('denied', 'SecurityError');
      return setItem.call(this, key, value);
    });
    await mount(); fireEvent.click(standalone());
    await waitFor(() => expect(row(2)).toBeVisible());
    await filter('分配给我');
    expect(row(1)).toBeVisible(); expect(row(2)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('负责人筛选无法保存到浏览器');
    expect(JSON.parse(localStorage.getItem(preference)!)).toEqual({ kind: 'unassigned' });
    vi.mocked(Storage.prototype.setItem).mockRestore();
    await filter('所有负责人');
    expect(row(1)).toBeVisible(); expect(row(2)).toBeVisible();
    expect(screen.queryByText(/负责人筛选无法保存到浏览器/)).toBeNull();
    expect(JSON.parse(localStorage.getItem(preference)!)).toEqual({ kind: 'all' });
  });

  it('shows read errors in both locales while allowing a filter selection', async () => {
    install([task(1, TEST_VIEWER_ID), task(2, null)]);
    const preference = `daynight:task-assignee-filter:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === preference) throw new DOMException('denied', 'SecurityError');
      return getItem.call(this, key);
    });
    const view = await mount(); fireEvent.click(standalone());
    await waitFor(() => expect(row(1)).toBeVisible());
    expect(screen.getByText(/无法读取浏览器保存的负责人筛选/)).toBeVisible();
    view.setLocale('en');
    expect(screen.getByText(/The saved assignee filter could not be read/)).toBeVisible();
    view.setLocale('zh-CN');
    await filter('分配给我');
    expect(row(1)).toBeVisible(); expect(row(2)).toBeNull();
    expect(screen.queryByText(/无法读取浏览器保存的负责人筛选/)).toBeNull();
  });

  it('reports an invalid preference and defaults to all without blocking later choices', async () => {
    install([task(1, TEST_VIEWER_ID), task(2, null)]);
    const preference = `daynight:task-assignee-filter:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
    localStorage.setItem(preference, '{');
    await mount(); fireEvent.click(standalone());
    await waitFor(() => expect(row(1)).toBeVisible());
    expect(row(2)).toBeVisible();
    expect(screen.getByText(/浏览器保存的负责人筛选无效/)).toBeVisible();
    await filter('分配给我');
    expect(row(1)).toBeVisible(); expect(row(2)).toBeNull();
    expect(JSON.parse(localStorage.getItem(preference)!)).toEqual({ kind: 'me' });
  });

  it('saves the actual filter after overview navigation clears a blocking preference', async () => {
    install([task(1, otherUser), task(2, otherUser, { dependsOn: [id(1)] })]);
    const preference = `daynight:task-assignee-filter:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
    const view = await mount();
    await filter('分配给我');
    expect(JSON.parse(localStorage.getItem(preference)!)).toEqual({ kind: 'me' });
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(JSON.parse(localStorage.getItem(preference)!)).toEqual({ kind: 'all' });
    view.unmount();
    await mount();
    expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent('所有负责人');
    await waitFor(() => expect(chain(1)).toBeVisible());
  });

  it('retains the real Goal and all children with full progress when a child matches', async () => {
    const fixture = install([
      task(1, otherUser, { status: 'done', completedAt: '2026-10-22T10:00:00Z' }), task(2, otherUser, { dependsOn: [id(1)], status: 'in_progress', startedAt: '2026-10-22T10:00:00Z' }),
      task(3, TEST_VIEWER_ID, { dependsOn: [id(2)], blockedBy: [id(2)], ready: false }),
      task(4, otherUser, { dependsOn: [id(1)], status: 'done', completedAt: '2026-10-22T10:00:00Z' }),
      task(5, TEST_VIEWER_ID),
    ]);
    await mount();
    await filter('分配给我');
    expect(chain(1)).toBeVisible();
    expect(chain(1)!.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('2/4 已完成');
    expect(chain(1)).toHaveTextContent('1 进行中');
    fireEvent.click(chain(1)!);
    const children = document.getElementById(`goal-children-${id(1)}`)!;
    expect(children.querySelectorAll('.goal-task-row')).toHaveLength(3);
    expect(children).toHaveTextContent('Task 2');
    expect(children).toHaveTextContent('Task 4');
    const child = document.getElementById(`chain-task-${id(1)}-${id(3)}`)!;
    expect(child.closest('.goal-task-row')).toHaveTextContent('被阻塞');
    fireEvent.click(child);
    const detail = screen.getByRole('dialog');
    await within(detail).findByRole('heading', { name: 'Task 3' });
    expect(within(detail).getAllByRole('button', { name: 'Task 2，普通依赖' })).toHaveLength(2);
    expect(fixture.tasks.get(id(3))!.dependsOn).toEqual([id(2)]);
    expect(fixture.tasks.size).toBe(5);
  });

  it('requires both filters to match the same ordinary chain member and keeps every member', async () => {
    install([
      task(1, otherUser, { status: 'done' }),
      task(2, TEST_VIEWER_ID, { dependsOn: [id(1)], status: 'todo' }),
      task(3, otherUser, { dependsOn: [id(1)], status: 'in_progress' }),
      task(4, otherUser, { status: 'done' }),
      task(5, TEST_VIEWER_ID, { dependsOn: [id(4)], status: 'in_progress' }),
      task(6, otherUser, { dependsOn: [id(4)], status: 'done' }),
      task(7, otherUser, { dependsOn: [id(6), id(8)], status: 'todo' }),
      task(8, otherUser, { status: 'done' }),
      task(9, TEST_VIEWER_ID, { status: 'todo' }),
      task(10, otherUser, { status: 'in_progress' }),
    ]);
    await mount();
    await filter('分配给我');
    status('todo');
    expect(chain(1)).toBeVisible();
    expect(chain(4)).toBeNull();
    fireEvent.click(chain(1)!);
    const children = document.getElementById(`goal-children-${id(1)}`)!;
    expect(children.querySelectorAll('.goal-task-row')).toHaveLength(2);
    expect(children).toHaveTextContent('Task 2');
    expect(children).toHaveTextContent('Task 3');
    fireEvent.click(standalone());
    expect(row(9)).toBeVisible();
    expect(row(10)).toBeNull();
    status('in_progress');
    expect(row(9)).toBeNull();
    expect(row(10)).toBeNull();
    fireEvent.click(chains());
    expect(chain(4)).toBeVisible();
    expect(chain(1)).toBeNull();
    fireEvent.click(chain(4)!);
    const merged = document.getElementById(`goal-children-${id(4)}`)!;
    expect(merged.querySelectorAll('.goal-task-row')).toHaveLength(4);
    expect(merged).toHaveTextContent('Task 8');
  });

  it('does not count an external prerequisite as a matching member of a chain', async () => {
    install([
      task(1, otherUser), task(2, otherUser, { dependsOn: [id(1), id(3)], externalDependsOn: [id(3)] }),
      task(3, TEST_VIEWER_ID, { status: 'done' }),
    ]);
    await mount(); await filter('分配给我'); status('done');
    expect(chain(1)).toBeNull();
    fireEvent.click(standalone());
    expect(row(3)).toBeVisible();
  });

  it('resets both category pages on every filter change even when both result sets still have multiple pages', async () => {
    install(Array.from({ length: 41 }, (_, position) => {
      const root = position * 2 + 1;
      return [task(root, TEST_VIEWER_ID), task(root + 1, TEST_VIEWER_ID, { dependsOn: [id(root)] }), task(1000 + position, TEST_VIEWER_ID)];
    }).flat());
    const assigneePicker = () => {
      const element = document.querySelector<HTMLElement>('.task-assignee-filter');
      if (element === null) throw new Error('Assignee filter not found');
      return within(element);
    };
    await mount(() => waitFor(() => assigneePicker().getByRole('button', { name: /^负责人:/ })));
    fireEvent.click(within(pagination('任务链列表')).getByRole('button', { name: '下一页' }));
    expect(pagination('任务链列表')).toHaveTextContent('第 2 / 3 页');
    fireEvent.click(standalone());
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    expect(pagination('独立任务列表')).toHaveTextContent('第 2 / 3 页');
    fireEvent.click(assigneePicker().getByRole('button', { name: /^负责人:/ }));
    fireEvent.click(await assigneePicker().findByRole('option', { name: '分配给我' }));
    expect(pagination('独立任务列表')).toHaveTextContent('第 1 / 3 页');
    fireEvent.click(chains());
    expect(pagination('任务链列表')).toHaveTextContent('第 1 / 3 页');
    fireEvent.click(within(pagination('任务链列表')).getByRole('button', { name: '下一页' }));
    fireEvent.click(standalone());
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    status('todo');
    expect(pagination('独立任务列表')).toHaveTextContent('第 1 / 3 页');
    fireEvent.click(chains());
    expect(pagination('任务链列表')).toHaveTextContent('第 1 / 3 页');
  });

  it('uses an assignee-specific empty state while the full overview still navigates to an excluded Goal', async () => {
    install([task(1, otherUser), task(2, otherUser, { dependsOn: [id(1)] }), task(3, otherUser)]);
    await mount();
    await filter('分配给我');
    expect(screen.getByRole('heading', { name: '没有匹配筛选条件的任务' })).toBeVisible();
    fireEvent.click(standalone());
    expect(screen.getByRole('heading', { name: '没有匹配筛选条件的任务' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent('所有负责人');
    expect(chain(1)).toBeVisible();
  });

  it('preserves matching conditions for a nonrepresentative member and clears only a blocking status', async () => {
    install([task(1, otherUser, { status: 'done' }), task(2, TEST_VIEWER_ID, { dependsOn: [id(1)] }), task(3, otherUser)]);
    await mount(); await filter('分配给我'); status('todo');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(chain(1)).toHaveClass('overview-progress-target');
    expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('todo');
    expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent('分配给我');
    status('done');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('all');
    expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent('分配给我');
  });

  it('clears only blocking conditions for the standalone overview aggregate and focuses its panel', async () => {
    install([task(1, TEST_VIEWER_ID), task(2, otherUser)]);
    await mount(); await filter('分配给我'); status('todo');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /^独立任务，/ }));
    const panel = screen.getByRole('tabpanel', { name: '独立任务' });
    await waitFor(() => expect(panel).toHaveFocus());
    expect(panel).toHaveClass('overview-progress-target');
    expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('todo');
    expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent('所有负责人');
    expect(row(1)).toBeVisible(); expect(row(2)).toBeVisible();
  });

  it('filters unassigned and former assignees while excluding former members from assignment choices', async () => {
    install([task(1, null), task(2, formerUser), task(3, TEST_VIEWER_ID)]);
    await mount();
    fireEvent.click(standalone());
    await filter('未分配');
    expect(row(1)).toBeVisible();
    expect(row(2)).toBeNull();
    expect(row(3)).toBeNull();
    await filter(/^Former person/);
    expect(row(1)).toBeNull();
    expect(row(2)).toBeVisible();
    expect(row(3)).toBeNull();
    fireEvent.click(row(2)!);
    const detail = screen.getByRole('dialog');
    await within(detail).findByRole('heading', { name: 'Task 2' });
    fireEvent.click(within(detail).getByRole('button', { name: '负责人：Former person · 已失去项目权限' }));
    await within(detail).findByRole('option', { name: 'Other person' });
    expect(within(detail).queryByRole('option', { name: /^Former person/ })).toBeNull();
  });

  it('keeps the mounted detail, active tab and upload draft when reassignment removes its filtered row', async () => {
    const { fetcher } = install([task(1, TEST_VIEWER_ID), task(2, otherUser)]);
    await mount();
    fireEvent.click(standalone());
    await filter('分配给我');
    fireEvent.click(row(1)!);
    const detail = screen.getByRole('dialog');
    await within(detail).findByRole('heading', { name: 'Task 1' });
    fireEvent.click(within(detail).getByRole('tab', { name: '附件' }));
    fireEvent.click(await within(detail).findByText('上传文件', { selector: 'summary' }));
    const draft = within(detail).getByRole('textbox', { name: '目标相对路径' });
    fireEvent.change(draft, { target: { value: 'retained/draft.md' } });
    fireEvent.click(within(detail).getByRole('button', { name: /^负责人：/ }));
    fireEvent.click(await within(detail).findByRole('option', { name: 'Other person' }));
    await waitFor(() => expect(row(1)).toBeNull());
    expect(screen.getByRole('dialog')).toBe(detail);
    expect(within(detail).getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    expect(draft).toHaveValue('retained/draft.md');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
  });
});
