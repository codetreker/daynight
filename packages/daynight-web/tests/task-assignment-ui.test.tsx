import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPerson } from '../src/api/auth-types';
import type { TaskDetail } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import type { Locale } from '../src/i18n/locale';
import assignmentStyles from '../src/styles/task-assignment.css?raw';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { TEST_VIEWER_ID, taskSyncQuery, taskSyncResponse } from './helpers/taskSync';

const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const otherUser = '00000000-0000-4000-8000-000000000202';
const formerUser = '00000000-0000-4000-8000-000000000203';
const nullNameUser = '10000000-0000-4000-8000-000000000204';
const longName = 'A person with a sufficiently long display name to require truncation in a task row';
const people: readonly ProjectPerson[] = [
  { version: "a".repeat(64), userId: TEST_VIEWER_ID, name: longName, avatarUrl: '/broken-avatar.png', hasProjectAccess: true },
  { version: "a".repeat(64), userId: otherUser, name: 'Other person', avatarUrl: null, hasProjectAccess: true },
  { version: "a".repeat(64), userId: formerUser, name: 'Former person', avatarUrl: null, hasProjectAccess: false },
  { version: "a".repeat(64), userId: nullNameUser, name: null, avatarUrl: null, hasProjectAccess: true },
];

beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${projectId}`);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

const install = (initial: readonly TaskDetail[]) => {
  const tasks = new Map(initial.map((task) => [task.id, task]));
  const fetcher = vi.fn(async (address: string, options?: RequestInit): Promise<Response> => {
    const url = new URL(address, location.origin);
    if (url.pathname === `/api/v1/projects/${projectId}/task-sync`) return taskSyncResponse(graphFixture([...tasks.values()]), {
      assigneeVersions: people.map(({ userId, version, hasProjectAccess }) => ({ userId, version, hasProjectAccess })),
      viewerId: TEST_VIEWER_ID, query: taskSyncQuery(url), versionForTask: (task) => tasks.get(task.id)!.version,
      propertiesForTask: (task) => tasks.get(task.id)!.properties,
    });
    if (url.pathname === `/api/v1/projects/${projectId}/task-assignees`) {
      const requested = url.searchParams.getAll('userId');
      return resourceResponse({ items: people.filter((person) => requested.length === 0 || requested.includes(person.userId)), unresolvedUserIds: requested.filter((id) => !people.some((person) => person.userId === id)) }, TEST_VIEWER_ID);
    }
    const match = new RegExp(`^/api/v1/projects/${projectId}/tasks/([^/]+)$`).exec(url.pathname);
    if (match !== null) {
      const previous = tasks.get(match[1]!)!;
      if (options?.method === 'PATCH') {
        const body = JSON.parse(String(options.body));
        const changed = previous.assignedTo !== body.assignedTo;
        const next = changed ? { ...previous, assignedTo: body.assignedTo as string | null, allowAgents: false, version: previous.version + 1n, updatedAt: '2026-10-22T10:01:00Z' } : previous;
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
const mount = async (locale: Locale = 'en') => {
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(<ProjectPage projectId={projectId} />, { container: root, locale, taskCache: true });
  fireEvent.click(screen.getByRole('tab', { name: locale === 'en' ? 'Task list' : '任务列表' }));
  const standalone = await screen.findByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' });
  fireEvent.click(standalone);
};
const open = async () => {
  fireEvent.click(document.getElementById(`standalone-task-${taskId}`)!);
  const detail = screen.getByRole('dialog');
  await within(detail).findByRole('heading', { name: 'Assignment task' });
  return detail;
};
const initialTask = (changes: Partial<TaskDetail> = {}) => detailFixture(projectId, taskId, { title: 'Assignment task', assignedTo: TEST_VIEWER_ID, ...changes });

describe('task assignment interface', () => {
  it.each(['en', 'zh-CN'] as const)('shows names, null names, unassigned tasks and confirmed former members in %s without nested row controls', async (locale) => {
    install([
      initialTask(),
      detailFixture(projectId, '00000000-0000-4000-8000-000000000002', { assignedTo: null, title: 'Unassigned task' }),
      detailFixture(projectId, '00000000-0000-4000-8000-000000000003', { assignedTo: formerUser, title: 'Former task' }),
      detailFixture(projectId, '00000000-0000-4000-8000-000000000004', { assignedTo: nullNameUser, title: 'Null name task' }),
    ]);
    await mount(locale);
    const prefix = locale === 'en' ? 'Assignee: ' : '负责人：';
    expect(await screen.findByLabelText(`${prefix}${longName}`)).toHaveAttribute('title', `${prefix}${longName}`);
    expect(screen.getByLabelText(`${prefix}${locale === 'en' ? 'Unassigned' : '未分配'}`)).toBeVisible();
    expect(await screen.findByLabelText(`${prefix}Former person · ${locale === 'en' ? 'No project access' : '已失去项目权限'}`)).toBeVisible();
    expect(await screen.findByLabelText(`${prefix}10000000`)).toBeVisible();
    for (const row of document.querySelectorAll('.standalone-row')) expect(row.querySelectorAll('button')).toHaveLength(0);
    const identity = screen.getByLabelText(`${prefix}${longName}`);
    fireEvent.error(identity.querySelector('img')!);
    expect(identity.querySelector('img')).toBeNull();
    expect(identity.querySelector('.assignee-avatar')).toHaveTextContent('A');
    expect(identity).toHaveAttribute('aria-label', `${prefix}${longName}`);
    fireEvent.click(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000003')!);
    const detail = screen.getByRole('dialog');
    await within(detail).findByRole('heading', { name: 'Former task' });
    const formerStatus = locale === 'en' ? 'No project access' : '已失去项目权限';
    const trigger = within(detail).getByRole('button', { name: `${prefix}Former person · ${formerStatus}` });
    const badge = within(trigger).getByText(formerStatus, { selector: '.assignee-former' });
    const style = document.createElement('style');
    style.textContent = assignmentStyles;
    document.head.append(style);
    try { expect(badge).toBeVisible(); }
    finally { style.remove(); }
  });

  it('keeps the popup inside the detail, closes an equal choice without writing and isolates Escape from the parent dialog', async () => {
    const { fetcher } = install([initialTask()]);
    await mount();
    const detail = await open();
    const trigger = within(detail).getByRole('button', { name: /^Assignee:/ });
    fireEvent.click(trigger);
    const search = await within(detail).findByRole('textbox', { name: 'Search people' });
    expect(search).toHaveFocus();
    expect(detail).toContainElement(screen.getByRole('dialog', { name: 'Assignee' }));
    fireEvent.click(await within(detail).findByRole('option', { name: longName }));
    expect(screen.queryByRole('dialog', { name: 'Assignee' })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0);
    fireEvent.click(trigger);
    const reopenedSearch = within(detail).getByRole('textbox', { name: 'Search people' });
    expect(fireEvent.keyDown(reopenedSearch, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Assignee' })).toBeNull();
    expect(screen.getByRole('dialog')).toBe(detail);
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps text-editing keys native, selects from the keyboard and leaves Tab focus at the next detail control', async () => {
    const { fetcher, tasks } = install([initialTask({ allowAgents: true })]);
    await mount();
    const detail = await open();
    const trigger = within(detail).getByRole('button', { name: /^Assignee:/ });
    fireEvent.click(trigger);
    const search = await within(detail).findByRole('textbox', { name: 'Search people' });
    await within(detail).findByRole('option', { name: 'Other person' });
    fireEvent.change(search, { target: { value: 'Other' } });
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true);
    expect(search).toHaveFocus();
    expect(search).toHaveValue('Other');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(within(detail).getByRole('option', { name: 'Other person' })).toHaveFocus();
    await userEvent.setup().keyboard('{Enter}');
    await waitFor(() => expect(tasks.get(taskId)!.assignedTo).toBe(otherUser));
    expect(tasks.get(taskId)!.allowAgents).toBe(false);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    await within(detail).findByRole('option', { name: 'Other person' });
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    const querySelectorAll = detail.querySelectorAll.bind(detail);
    vi.spyOn(detail, 'querySelectorAll').mockImplementation(<E extends Element = Element,>(selectors: string): NodeListOf<E> =>
      [...querySelectorAll<E>(selectors)].sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) as unknown as NodeListOf<E>);
    await userEvent.setup().tab();
    expect(screen.queryByRole('dialog', { name: 'Assignee' })).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    expect(detail).toContainElement(document.activeElement as HTMLElement);
    expect(within(detail).getByRole('combobox', { name: 'Execution platform' })).toHaveFocus();
  });

  it('marks an unknown write for verification while retaining the old assignee and hiding the old automation value', async () => {
    const { fetcher } = install([initialTask({ allowAgents: true })]);
    const handler = fetcher.getMockImplementation()!;
    let responseLost = false;
    fetcher.mockImplementation(async (address, options) => {
      if (options?.method === 'PATCH') { responseLost = true; throw new TypeError('The response was lost.'); }
      if (responseLost && new URL(address, location.origin).pathname === `/api/v1/projects/${projectId}/tasks/${taskId}`) return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return handler(address, options);
    });
    await mount();
    const detail = await open();
    const trigger = within(detail).getByRole('button', { name: /^Assignee:/ });
    fireEvent.click(trigger);
    fireEvent.click(await within(detail).findByRole('option', { name: 'Other person' }));
    expect(await within(detail).findByText('Pending verification', { selector: '.task-assignment-uncertain' })).toBeVisible();
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAccessibleName(`Assignee: ${longName}`);
    expect(within(detail).queryByRole('switch')).toBeNull();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
  });
});
