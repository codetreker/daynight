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
  { userId: TEST_VIEWER_ID, name: 'Current person', avatarUrl: null, hasProjectAccess: true },
  { userId: otherUser, name: 'Other person', avatarUrl: null, hasProjectAccess: true },
  { userId: formerUser, name: 'Former person', avatarUrl: null, hasProjectAccess: false },
];
const render = createLocaleRender('zh-CN');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

const install = (initial: readonly TaskDetail[]) => {
  const tasks = new Map(initial.map((value) => [value.id, value]));
  const fetcher = vi.fn(async (address: string, options?: RequestInit): Promise<Response> => {
    const url = new URL(address, location.origin);
    if (url.pathname === `/api/v1/projects/${projectId}/task-sync`) return taskSyncResponse(graphFixture([...tasks.values()]), {
      viewerId: TEST_VIEWER_ID, query: taskSyncQuery(url), versionForTask: (value) => tasks.get(value.id)!.version,
      propertiesForTask: (value) => tasks.get(value.id)!.properties,
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
const mount = async () => {
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const view = render(<ProjectPage projectId={projectId} />, { container: root, taskCache: true });
  fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
  await screen.findByRole('button', { name: /^负责人:/ });
  return view;
};
const filter = async (label: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: /^负责人:/ }));
  fireEvent.click(await screen.findByRole('option', { name: label }));
};
const chains = () => screen.getByRole('tab', { name: '任务链' });
const standalone = () => screen.getByRole('tab', { name: '独立任务' });
const row = (value: number) => document.getElementById(`standalone-task-${id(value)}`);
const chain = (value: number) => document.getElementById(`task-root-${id(value)}`);
const pagination = (name: string) => screen.getByRole('navigation', { name: `${name}分页` });

describe('project assignee filtering', () => {
  it('retains the real Goal and full progress while matching children remain blocked by hidden unfinished predecessors', async () => {
    const fixture = install([
      task(1, otherUser, { status: 'done', completedAt: '2026-10-22T10:00:00Z' }), task(2, otherUser, { dependsOn: [id(1)], status: 'in_progress', startedAt: '2026-10-22T10:00:00Z' }),
      task(3, TEST_VIEWER_ID, { dependsOn: [id(2)], blockedBy: [id(2)], ready: false }),
      task(4, otherUser, { dependsOn: [id(1)], status: 'done', completedAt: '2026-10-22T10:00:00Z' }),
      task(5, TEST_VIEWER_ID),
    ]);
    await mount();
    await filter('分配给我');
    expect(chain(1)).toBeVisible();
    expect(chain(1)).toHaveTextContent('2/4 已完成');
    expect(chain(1)).toHaveTextContent('1 进行中');
    fireEvent.click(chain(1)!);
    const children = document.getElementById(`goal-children-${id(1)}`)!;
    expect(children).toHaveTextContent('1 个匹配子任务');
    expect(children.querySelectorAll('.goal-task-row')).toHaveLength(1);
    const child = document.getElementById(`chain-task-${id(1)}-${id(3)}`)!;
    expect(child).toHaveTextContent('被阻塞');
    fireEvent.click(child);
    const detail = screen.getByRole('dialog');
    await within(detail).findByRole('heading', { name: 'Task 3' });
    expect(within(detail).getAllByRole('button', { name: 'Task 2，普通依赖' })).toHaveLength(2);
    expect(fixture.tasks.get(id(3))!.dependsOn).toEqual([id(2)]);
    expect(fixture.tasks.size).toBe(5);
  });

  it('resets both category pages on every filter change even when both result sets still have multiple pages', async () => {
    install(Array.from({ length: 32 }, (_, position) => {
      const root = position * 2 + 1;
      return [task(root, TEST_VIEWER_ID), task(root + 1, TEST_VIEWER_ID, { dependsOn: [id(root)] }), task(1000 + position, TEST_VIEWER_ID)];
    }).flat());
    await mount();
    fireEvent.click(within(pagination('任务链列表')).getByRole('button', { name: '下一页' }));
    expect(pagination('任务链列表')).toHaveTextContent('第 2 / 3 页');
    fireEvent.click(standalone());
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    expect(pagination('独立任务列表')).toHaveTextContent('第 2 / 3 页');
    await filter('分配给我');
    expect(pagination('独立任务列表')).toHaveTextContent('第 1 / 3 页');
    fireEvent.click(chains());
    expect(pagination('任务链列表')).toHaveTextContent('第 1 / 3 页');
  });

  it('uses an assignee-specific empty state while the full overview still navigates to an excluded Goal', async () => {
    install([task(1, otherUser), task(2, otherUser, { dependsOn: [id(1)] }), task(3, otherUser)]);
    await mount();
    await filter('分配给我');
    expect(screen.getByRole('heading', { name: '没有匹配此负责人的任务' })).toBeVisible();
    fireEvent.click(standalone());
    expect(screen.getByRole('heading', { name: '没有匹配此负责人的任务' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 1，/ }));
    await waitFor(() => expect(chain(1)).toHaveFocus());
    expect(screen.getByRole('button', { name: /^负责人:/ })).toHaveTextContent('所有负责人');
    expect(chain(1)).toBeVisible();
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
