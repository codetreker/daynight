import { browserNavigation } from "../src/app/navigation";
import { projectHistory, readProjectHistory } from '../src/app/page-history';
import { summariesForGraph } from './helpers/taskSync';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { TEST_VIEWER_ID, taskSyncReadFixture, createGraphSyncFixture } from "./helpers/taskSync";
import { act, cleanup, fireEvent, render as rawRender, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, getTaskSync } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import { getProjectAccess } from '../src/api/auth';
import { directAccessFixture } from './helpers/taskSync';
import type { GraphTask, TaskGraph, WorkerClaim } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import * as ProjectOverviewModule from '../src/features/projects/ProjectOverview';
import * as TaskGraphModule from '../src/features/projects/useTaskGraph';
import * as TaskAssigneeFilterModule from '../src/features/task-assignment/TaskAssigneeFilter';
import { buildGraphIndex, projectChain, type GraphIndex } from '../src/features/task-graph/model';
import { LocaleProvider } from '../src/i18n/LocaleProvider';
import { TestTaskCacheBoundary } from './helpers/taskCache';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), getTaskSync: vi.fn(),
  listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })),
  attachmentPreviewRoot: (projectId: string, taskId: string) => `/fixtures/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/preview/`, }; });
vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/features/task-tags/ProjectTags', () => ({ ProjectTags: ({ projectId, active }: { projectId: string; active: boolean }) => <p data-testid="project-tags" data-active={String(active)}>{projectId}</p> }));
vi.mock('../src/features/task-graph/TaskGraph', () => ({ TaskGraph: ({ index, rootId, onOpenTask, onNavigateExternalTask }: {
  index: GraphIndex; rootId: string; onOpenTask: (id: string, trigger: HTMLElement) => void;
  onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
}) => <><button data-testid="graph-node" onClick={(event) => { onOpenTask(rootId, event.currentTarget); }}>图节点 {index.nodes.get(rootId)!.titlePreview}</button>
  {[...projectChain(index, rootId).externalIds].map((id) => <button key={id} data-testid={`external-${id}`} onClick={(event) => onNavigateExternalTask!(id, event.currentTarget)}>展开 {id}</button>)}</> }));

const project = '00000000-0000-4000-8000-000000000100';
const otherProject = '00000000-0000-4000-8000-000000000200';
const canonicalTask = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const timestamp = '2026-10-20T12:00:00.123456Z';
const seed = (id: string, status: GraphTask['status'] = 'todo', dependsOn: string[] = [], externalDependsOn: string[] = []): GraphTask => ({ type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn, startedAt: null, completedAt: null, cancelledAt: null,
  id, titlePreview: `任务 ${id}`, titleTruncated: false, status, dependsOn, blockedBy: [], ready: false,
  createdAt: timestamp, updatedAt: timestamp,
});
const seeds = [seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000003'), seed('00000000-0000-4000-8000-000000000004', 'done'), seed('00000000-0000-4000-8000-000000000005', 'in_progress')];
const snapshot = (items = seeds, id = project): TaskGraph => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((dependency) => items.find((candidate) => candidate.id === dependency)!.status !== 'done' && items.find((candidate) => candidate.id === dependency)!.status !== 'cancelled');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  return { observedAt: "2026-10-20T12:00:00Z", project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id, name: id, repoUrl: 'https://github.com/example/repo', createdAt: timestamp, updatedAt: timestamp }, tasks,
    summary: { proposed: 0, total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length,
      done: tasks.filter((item) => item.status === 'done').length, cancelled: tasks.filter((item) => item.status === 'cancelled').length, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
      ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length } };
};
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const mockedSessionStores: { scope: TaskCacheScope; store: TaskSessionSummaryStore }[] = [];
const mockSessionStore = () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const store = new TaskSessionSummaryStore(scope, project);
  mockedSessionStores.push({ scope, store });
  return store;
};
afterEach(() => { for (const { scope, store } of mockedSessionStores.splice(0)) { store.dispose(); scope.dispose(); } });
const mockNavigationSnapshot = (tasks: GraphTask[], revision: number): TaskGraphModule.GraphSnapshot => {
  const graph = snapshot(tasks);
  return { graph, index: buildGraphIndex(graph), summaries: summariesForGraph(graph), workerMachines: new Map(), pausedTaskIds: new Set<string>(), observedAt: graph.observedAt, receivedAt: Date.now(), receivedMonotonic: performance.now(), revision };
};
const waitForGraph = () => waitFor(() => expect(document.querySelector('.snapshot-time time')).not.toBeNull());
const sectionTabs = () => within(root.querySelector<HTMLElement>('.project-section-tabs')!);
const taskTabs = () => within(root.querySelector<HTMLElement>('.project-task-tabs')!);
const titleActions = () => within(root.querySelector<HTMLElement>('.project-title-actions')!);
const filters = () => within(root.querySelector<HTMLElement>('#project-section-panel-tasks .task-list-filters:not(.task-search-filters)')!);
const overviewProgress = () => within(document.getElementById('project-overview-progress')!);
const sectionTab = (section: 'overview' | 'tasks' | 'tags') => sectionTabs().getByRole('tab', { name: section === 'overview' ? '概览' : section === 'tasks' ? '任务列表' : '标签' });
const tab = (view: 'chains' | 'standalone' | 'goals') => taskTabs().getByRole('tab', { name: view === 'chains' ? '任务链' : view === 'standalone' ? '独立任务' : 'Goal' });
const findTab = (view: 'chains' | 'standalone') => waitFor(() => tab(view));
const expectUnfinishedCounts = (chains: number, standalone: number) => {
  expect(tab('chains').querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${chains}$`));
  expect(tab('standalone').querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${standalone}$`));
};
const row = (id: string) => document.getElementById(`standalone-task-${id}`)!;
const chainRow = (id = canonicalTask(1)) => document.getElementById(`task-root-${id}`)!;
const chainGraphButton = (id = canonicalTask(1)) => document.getElementById(`task-chain-graph-${id}`)!;
const findChainRow = async (id = canonicalTask(1)) => {
  await waitFor(() => expect(chainRow(id)).toBeVisible());
  return chainRow(id);
};
const openChain = async (id = canonicalTask(1)) => {
  await findChainRow(id);
  fireEvent.click(chainGraphButton(id));
  return screen.findByTestId('graph-node');
};
const closeChain = () => fireEvent.click(document.querySelector<HTMLButtonElement>('.task-chain-close')!);
const key = (kind: string, id = project) => `daynight:${kind}:${id}`;
let root: HTMLDivElement;

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const workerClaims = new Map<string, WorkerClaim>();
const syncFixture = createGraphSyncFixture({ propertiesForTask: (task) => ({ pullRequests: [], ...(workerClaims.has(task.id) ? { worker: workerClaims.get(task.id)! } : {}) }) });
const servedGraphs = new Map<string, TaskGraph>();
const servedVersions = new Map<string, bigint>();
beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${project}`);
  vi.mocked(getProject).mockReset().mockImplementation(async id => snapshot(seeds, id).project);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (id, _signal, admission) => directAccessFixture(id, admission.userId));
  syncFixture.reset(); workerClaims.clear();
  servedGraphs.clear(); servedVersions.clear();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    const sync = syncFixture.toSync(value, query, replacementEpochs.get(value));
    servedGraphs.set(projectId, value);
    for (const task of sync.tasks) servedVersions.set(`${projectId}/${task.id}`, task.version);
    return taskSyncReadFixture(sync);
  });
});

beforeEach(() => {
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  graphRequest.mockReset(); graphRequest.mockImplementation(async (id) => servedGraphs.get(id) ?? snapshot(seeds, id));
  vi.mocked(getTask).mockReset();
  vi.mocked(getTask).mockImplementation(async (projectId, id) => {
    const task = servedGraphs.get(projectId)!.tasks.find((item) => item.id === id)!;
    return { ...task, tags: [], id, projectId, title: task.titlePreview, description: '', properties: { pullRequests: [] }, version: servedVersions.get(`${projectId}/${id}`)! };
  });
});
afterEach(() => { cleanup(); root.remove(); });
const selectTasks = () => { fireEvent.click(sectionTab('tasks')); };
const mount = () => {
  if (!root.isConnected) document.body.append(root);
  const view = render(<ProjectPage projectId={project} />, { container: root });
  selectTasks();
  return view;
};

const openStandalone = async (id: string) => {
  fireEvent.click(tab('standalone'));
  const trigger = row(id); trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  await within(dialog.querySelector<HTMLElement>('.task-detail-header')!).findByRole('heading', { name: `任务 ${id}` });
  return { trigger, dialog };
};

describe('project task views', () => {
  it('shows real Goal summaries separately from scoped tasks and keeps an empty Goal visible', async () => {
    const goal = canonicalTask(500), emptyGoal = canonicalTask(501), rootId = canonicalTask(1), outsideId = canonicalTask(2), singleId = canonicalTask(3);
    graphRequest.mockResolvedValue(snapshot([
      { ...seed(goal, 'done'), type: 'goal' }, { ...seed(emptyGoal), type: 'goal' },
      { ...seed(rootId, 'done'), parentId: goal }, seed(outsideId, 'todo', [rootId]), { ...seed(singleId, 'cancelled'), parentId: goal },
    ]));
    mount(); await findTab('chains');
    const chain = await findChainRow(rootId);
    expect(chain.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('0/1');
    fireEvent.click(chain);
    expect(document.getElementById(`chain-task-${rootId}-${outsideId}`)).toBeVisible();
    expect(document.getElementById(`chain-task-${rootId}-${rootId}`)).toBeNull();
    fireEvent.click(tab('standalone'));
    expect(row(singleId)).toBeNull();
    fireEvent.click(tab('goals'));
    expect(document.getElementById(`project-goal-${goal}`)!.closest('.goal-list-row')).toHaveTextContent('1/1 已完成');
    expect(document.getElementById(`project-goal-${emptyGoal}`)!.closest('.goal-list-row')).toHaveTextContent('0/0 已完成');
  });

  it('paginates Goal summaries by twenty without counting children', async () => {
    const goals = Array.from({ length: 21 }, (_, position) => ({ ...seed(canonicalTask(500 + position)), type: 'goal' as const }));
    const children = Array.from({ length: 25 }, (_, position) => ({ ...seed(canonicalTask(700 + position)), parentId: goals[0]!.id }));
    graphRequest.mockResolvedValue(snapshot([...goals, ...children]));
    mount(); await findTab('chains'); fireEvent.click(tab('goals'));
    expect(document.querySelectorAll('.goal-list-row')).toHaveLength(20);
    const first = [...document.querySelectorAll<HTMLElement>('.goal-list-card')].map((element) => element.dataset.goalId);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Goal分页' })).getByRole('button', { name: '下一页' }));
    const second = [...document.querySelectorAll<HTMLElement>('.goal-list-card')].map((element) => element.dataset.goalId);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second]).size).toBe(21);
    const goalWithChildren = document.querySelector<HTMLElement>(`[data-goal-id="${goals[0]!.id}"]`)!;
    fireEvent.click(goalWithChildren.querySelector('.goal-list-toggle')!);
    expect(goalWithChildren.querySelectorAll('.goal-task-main')).toHaveLength(25);
    expect(document.querySelectorAll('.goal-list-card')).toHaveLength(1);
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it('filters typed Goals by their own status and assignee while retaining all children', async () => {
    const goal = canonicalTask(500), excluded = canonicalTask(501), single = canonicalTask(1), chain = canonicalTask(2), member = canonicalTask(3);
    graphRequest.mockResolvedValue(snapshot([
      { ...seed(goal), type: 'goal' }, { ...seed(excluded, 'done'), type: 'goal' },
      { ...seed(single, 'done'), parentId: goal, assignedTo: canonicalTask(900) },
      { ...seed(chain, 'todo'), parentId: goal, assignedTo: canonicalTask(900) },
      { ...seed(member, 'cancelled', [chain]), parentId: goal, assignedTo: canonicalTask(900) },
    ]));
    let changeAssignee!: Parameters<typeof TaskAssigneeFilterModule.TaskAssigneeFilter>[0]['onChange'];
    const ActualFilter = TaskAssigneeFilterModule.TaskAssigneeFilter;
    vi.spyOn(TaskAssigneeFilterModule, 'TaskAssigneeFilter').mockImplementation((props) => { changeAssignee = props.onChange; return <ActualFilter {...props} />; });
    mount(); await findTab('chains'); fireEvent.click(tab('goals'));
    fireEvent.change(filters().getByRole('combobox', { name: '状态' }), { target: { value: 'todo' } });
    act(() => changeAssignee({ kind: 'unassigned' }));
    expect(document.querySelectorAll('.goal-list-card')).toHaveLength(1);
    const card = document.querySelector<HTMLElement>(`[data-goal-id="${goal}"]`)!;
    fireEvent.click(card.querySelector('.goal-list-toggle')!);
    const children = [...card.querySelectorAll('.goal-task-main')];
    expect(children).toHaveLength(3);
    expect(children.map((item) => item.textContent).join(' ')).toContain(`任务 ${single}`);
    expect(children.map((item) => item.textContent).join(' ')).toContain(`任务 ${member}`);
    expect(document.querySelector(`[data-goal-id="${excluded}"]`)).toBeNull();
  });

  it('retains expanded Goals on a pending refresh and failure, then reflects changed Parent and dependencies on retry', async () => {
    const goal = canonicalTask(500), other = canonicalTask(501), a = canonicalTask(1), b = canonicalTask(2), c = canonicalTask(3);
    const initial = [{ ...seed(goal), type: 'goal' as const }, { ...seed(other), type: 'goal' as const },
      { ...seed(a), parentId: goal }, { ...seed(b, 'todo', [a]), parentId: goal }, { ...seed(c), parentId: goal }];
    const changed = initial.map((item) => item.id === b ? { ...item, parentId: other } : item.id === c ? { ...item, dependsOn: [a] } : item);
    let resolve!: (value: TaskGraph) => void;
    const pending = new Promise<TaskGraph>((done) => { resolve = done; });
    graphRequest.mockResolvedValueOnce(snapshot(initial)).mockReturnValueOnce(pending).mockRejectedValueOnce(new Error('Refresh failed')).mockResolvedValue(snapshot(changed));
    mount(); await findTab('chains'); fireEvent.click(tab('goals'));
    const card = document.querySelector<HTMLElement>(`[data-goal-id="${goal}"]`)!;
    const toggle = card.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    fireEvent.click(toggle);
    expect(card.querySelectorAll('.goal-task-main')).toHaveLength(3);
    expect(card).toHaveTextContent(`任务 ${c}`);
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(card.querySelectorAll('.goal-task-main')).toHaveLength(3);
    await act(async () => { resolve(snapshot(initial)); });
    await waitFor(() => expect(titleActions().getByRole('button', { name: '刷新' })).toBeEnabled());
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '刷新失败' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(card.querySelectorAll('.goal-task-main')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '重试刷新' }));
    await waitFor(() => expect(card.querySelectorAll('.goal-task-main')).toHaveLength(2));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(card.querySelector('.root-toggle')).toBeNull();
    const children = [...card.querySelectorAll('.goal-task-main')];
    expect(children).toHaveLength(2);
    expect(children.map((item) => item.textContent).join(' ')).toContain(`任务 ${c}`);
    expect(children.map((item) => item.textContent).join(' ')).not.toContain(`任务 ${b}`);
  });

  it('withdraws an expanded Goal on identity change and ignores the old identity’s late refresh', async () => {
    const goal = canonicalTask(500), child = canonicalTask(1), newGoal = canonicalTask(501);
    const initial = snapshot([{ ...seed(goal), type: 'goal' }, { ...seed(child), parentId: goal }]);
    const replacement = snapshot([{ ...seed(newGoal), type: 'goal' }]);
    let resolve!: (value: TaskGraph) => void;
    const pending = new Promise<TaskGraph>((done) => { resolve = done; });
    graphRequest.mockResolvedValueOnce(initial).mockReturnValueOnce(pending).mockResolvedValue(replacement);
    const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const second = createTaskCacheScope({ userId: canonicalTask(999), onIdentityMismatch: vi.fn() });
    const page = (scope: TaskCacheScope) => <LocaleProvider initial={{ locale: 'zh-CN', issue: null }}><TestTaskCacheBoundary scope={scope}><ProjectPage projectId={project} /></TestTaskCacheBoundary></LocaleProvider>;
    try {
      const view = rawRender(page(first), { container: root });
      selectTasks(); await findTab('chains'); fireEvent.click(tab('goals'));
      const card = document.querySelector<HTMLElement>(`[data-goal-id="${goal}"]`)!;
      fireEvent.click(card.querySelector('.goal-list-toggle')!);
      expect(card.querySelector('.goal-task-main')).toBeVisible();
      fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
      view.rerender(page(second));
      expect(document.querySelector(`[data-goal-id="${goal}"]`)).toBeNull();
      await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(3));
      await findTab('chains'); fireEvent.click(tab('goals'));
      await waitFor(() => expect(document.querySelector(`[data-goal-id="${newGoal}"]`)).toBeVisible());
      await act(async () => { resolve(initial); });
      expect(document.querySelector(`[data-goal-id="${goal}"]`)).toBeNull();
      expect(document.querySelector(`[data-goal-id="${newGoal}"]`)).toBeVisible();
    } finally { first.dispose(); second.dispose(); }
  });

  it('restores focus to a current entry after a previous detail and cross-Goal graph navigation', async () => {
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    try {
    const rootId = canonicalTask(1), child = canonicalTask(2), witness = canonicalTask(3), previous = canonicalTask(4), goal = canonicalTask(5);
    graphRequest.mockResolvedValue(snapshot([
      seed(rootId, 'done'), seed(child, 'todo', [rootId, witness], [witness]),
      { ...seed(witness, 'done'), parentId: goal }, seed(previous), { ...seed(goal), type: 'goal' },
    ]));
    mount(); await findTab('standalone');
    const { trigger: previousTrigger, dialog } = await openStandalone(previous);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(previousTrigger).toHaveFocus());
    fireEvent.click(tab('chains'));
    await openChain(rootId);
    fireEvent.click(screen.getByTestId(`external-${witness}`));
    const goalDialog = await screen.findByRole('dialog', { name: `任务 ${goal}` });
    const childDialog = await screen.findByRole('dialog', { name: `任务 ${witness}` });
    expect(goalDialog.querySelector('[data-goal-task-id]')).toBeNull();
    expect(goalDialog).toHaveAttribute('inert');
    fireEvent.click(within(childDialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(within(goalDialog).getByRole('heading', { name: `任务 ${goal}` })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId(`external-${witness}`)).toHaveFocus());
    expect(previousTrigger).not.toHaveFocus();
    expect(dialog.isConnected).toBe(false);
    } finally {
      if (scroll === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll);
    }
  });
  it('locates the real Goal when a graph Details target is a cross-scope ordinary member', async () => {
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    try {
      const representative = canonicalTask(1), outside = canonicalTask(2), goal = canonicalTask(5);
      graphRequest.mockResolvedValue(snapshot([
        { ...seed(representative, 'done'), parentId: goal }, seed(outside, 'todo', [representative]), { ...seed(goal), type: 'goal' },
      ]));
      mount(); await findTab('chains');
      fireEvent.click(await openChain(representative));
      const dialog = await screen.findByRole('dialog', { name: `任务 ${goal}` });
      const childDialog = await screen.findByRole('dialog', { name: `任务 ${representative}` });
      expect(childDialog).toBeVisible();
      expect(dialog.querySelector('[data-goal-task-id]')).toBeNull();
      expect(dialog.querySelector('.goal-information')).toHaveTextContent('任务链数1');
      expect(within(dialog).getByRole('tab', { name: '描述' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      if (scroll === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll);
    }
  });
  it('shows completed children of an unfinished Goal', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed(canonicalTask(1), 'done'),
      seed(canonicalTask(2), 'done', [canonicalTask(1)]),
      seed(canonicalTask(3), 'in_progress', [canonicalTask(1)]),
      seed(canonicalTask(4), 'todo', [canonicalTask(3)]),
    ]));
    mount();
    const goal = await findChainRow();
    expect(screen.queryByRole('checkbox', { name: '显示所有' })).toBeNull();
    fireEvent.click(goal);
    const list = document.getElementById(`goal-children-${canonicalTask(1)}`)!;
    const childRows = list.querySelectorAll<HTMLButtonElement>('.goal-task-main');
    expect(childRows).toHaveLength(3);
    for (const [position, status] of ['进行中', '待处理', '已完成'].entries()) {
      expect(childRows[position]).toBeVisible();
      expect(childRows[position]!.closest('.goal-task-row')!.querySelector('.root-status')).toHaveTextContent(status);
    }
    expect(goal.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    const completedChild = childRows[2]!;
    completedChild.focus();
    fireEvent.click(completedChild);
    const dialog = screen.getByRole('dialog');
    await within(dialog.querySelector<HTMLElement>('.task-detail-header')!).findByRole('heading', { name: `任务 ${canonicalTask(2)}` });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(completedChild).toHaveFocus());
    expect(completedChild).toBeVisible();
    expect(goal).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens child and Goal details from the expanded list and preserves disclosure and focus on return', async () => {
    mount();
    const goal = await findChainRow();
    fireEvent.click(goal);
    expect(goal).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('graph-node')).toBeNull();
    const child = document.getElementById(`chain-task-${canonicalTask(1)}-${canonicalTask(2)}`)!;
    child.focus();
    fireEvent.click(child);
    let dialog = screen.getByRole('dialog');
    await within(dialog.querySelector<HTMLElement>('.task-detail-header')!).findByRole('heading', { name: `任务 ${canonicalTask(2)}` });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(child).toHaveFocus());
    expect(goal).toHaveAttribute('aria-expanded', 'true');
    const goalDetails = document.querySelector<HTMLButtonElement>('.goal-detail-link')!;
    goalDetails.focus();
    fireEvent.click(goalDetails);
    dialog = screen.getByRole('dialog');
    await within(dialog.querySelector<HTMLElement>('.task-detail-header')!).findByRole('heading', { name: `任务 ${canonicalTask(1)}` });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(goalDetails).toHaveFocus());
    expect(goal).toHaveAttribute('aria-expanded', 'true');
    expect(goal.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    fireEvent.click(tab('standalone'));
    fireEvent.click(tab('chains'));
    expect(chainRow()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows waiting tasks in unfinished counts, chain summaries, statistics and standalone rows', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('00000000-0000-4000-8000-000000000001', 'todo'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']), seed('00000000-0000-4000-8000-000000000003'), seed('00000000-0000-4000-8000-000000000004', 'todo'),
      seed('00000000-0000-4000-8000-000000000005', 'done'), seed('00000000-0000-4000-8000-000000000006', 'todo', ['00000000-0000-4000-8000-000000000005']), seed('00000000-0000-4000-8000-000000000007', 'done'),
    ]));
    mount(); await findTab('chains');
    expectUnfinishedCounts(4, 1);
    const stats = screen.getByRole('region', { name: '项目任务统计', hidden: true });
    expect(stats.querySelectorAll('.stat')).toHaveLength(7);
    expect(stats).toHaveTextContent('待处理5等待开始');
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')?.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('待处理');
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')?.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('0/3 已完成');
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000003')).toBeNull();
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000005')?.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000004')).toHaveTextContent('待处理');
    expect(row('00000000-0000-4000-8000-000000000004').querySelector('.root-status')).toHaveClass('graph-status-todo');
    expect(row('00000000-0000-4000-8000-000000000004')).toHaveTextContent('可开始');
    expect(row('00000000-0000-4000-8000-000000000007')).toBeVisible();
    expectUnfinishedCounts(4, 1);
  });

  it('shows confirmed platform requirements in standalone rows without changing readiness', async () => {
    graphRequest.mockResolvedValue(snapshot(seeds.map((task) => ({ ...task, requiredPlatform: task.id === '00000000-0000-4000-8000-000000000003' ? 'linux' : task.id === '00000000-0000-4000-8000-000000000005' ? 'windows' : null }))));
    mount(); await findTab('standalone'); fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000003').querySelector('.task-platform')).toHaveTextContent('Linux');
    expect(row('00000000-0000-4000-8000-000000000005').querySelector('.task-platform')).toHaveTextContent('Windows');
    expect(row('00000000-0000-4000-8000-000000000003')).toHaveTextContent('可开始'); expect(row('00000000-0000-4000-8000-000000000005')).toHaveTextContent('进行中');
  });

  it('classifies complete dependencies independently from status and keeps summary and API order intact', async () => {
    const complete = snapshot(); graphRequest.mockResolvedValue(complete);
    mount(); await findTab('chains');
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    expectUnfinishedCounts(1, 2);
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(1);
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expect(screen.getByLabelText('显示 1 条，共 1 条任务链')).toHaveTextContent('1 / 1');
    fireEvent.click(tab('standalone'));
    expect([...document.querySelectorAll('.standalone-row')].map((item) => item.id)).toEqual(['standalone-task-00000000-0000-4000-8000-000000000005', 'standalone-task-00000000-0000-4000-8000-000000000003', 'standalone-task-00000000-0000-4000-8000-000000000004']);
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(row('00000000-0000-4000-8000-000000000003')).toHaveTextContent('可开始'); expect(row('00000000-0000-4000-8000-000000000005')).toHaveTextContent('进行中');
    expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000002')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '显示所有' })).toBeNull();
    fireEvent.click(sectionTab('overview'));
    expect(within(screen.getByRole('region', { name: '项目任务统计' })).getByText('5')).toBeVisible();
    selectTasks();
    expect(complete.tasks.map(({ id }) => id)).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005']);
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps an externally blocked singleton outside ordinary chains', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('00000000-0000-4000-8000-000000000001'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001'], ['00000000-0000-4000-8000-000000000001']),
    ]));
    mount(); await findTab('chains');
    expect(screen.getByRole('heading', { name: '暂无任务链' })).toBeVisible();
    expectUnfinishedCounts(0, 2);
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000001')).toBeVisible(); expect(row('00000000-0000-4000-8000-000000000002')).toBeVisible();
    expect(row('00000000-0000-4000-8000-000000000001').querySelector('.task-ready')).toHaveTextContent('可开始');
    expect(row('00000000-0000-4000-8000-000000000002').querySelector('.graph-blocked-badge')).toHaveTextContent('被阻塞');
    expect(row('00000000-0000-4000-8000-000000000002').querySelector('.task-ready')).toBeNull();
    expect(row('00000000-0000-4000-8000-000000000002').querySelector('.root-status')).toHaveTextContent('待处理');
  });

  it('counts unfinished tasks once across ordinary components and keeps both counts independent of visible rows', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'done'), seed('00000000-0000-4000-8000-000000000003', 'in_progress', ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']), seed('00000000-0000-4000-8000-000000000004', 'todo', ['00000000-0000-4000-8000-000000000003']),
      seed('00000000-0000-4000-8000-000000000005'), seed('00000000-0000-4000-8000-000000000006', 'todo', ['00000000-0000-4000-8000-000000000005']), seed('00000000-0000-4000-8000-000000000007'), seed('00000000-0000-4000-8000-000000000008', 'in_progress'), seed('00000000-0000-4000-8000-000000000009', 'done'),
      seed('00000000-0000-4000-8000-000000000010', 'done'), seed('00000000-0000-4000-8000-000000000011', 'done', ['00000000-0000-4000-8000-000000000010']),
    ]));
    mount(); await findTab('chains');
    expectUnfinishedCounts(4, 2);
    expect(tab('chains').querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成任务数');
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(3);
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000002')).toBeNull();
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000010')).toBeVisible();
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(3);
    expectUnfinishedCounts(4, 2);
    fireEvent.click(tab('standalone'));
    expect([...document.querySelectorAll('.standalone-row')].map((item) => item.id)).toEqual(['standalone-task-00000000-0000-4000-8000-000000000008', 'standalone-task-00000000-0000-4000-8000-000000000007', 'standalone-task-00000000-0000-4000-8000-000000000009']);
    expect(tab('standalone').querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成任务数');
    expect(row('00000000-0000-4000-8000-000000000009')).toBeVisible();
    expectUnfinishedCounts(4, 2);
    fireEvent.click(tab('chains'));
    expectUnfinishedCounts(4, 2);
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('shows zero unfinished tasks for completed chains and standalone tasks with either filter setting', async () => {
    graphRequest.mockResolvedValue(snapshot([seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'done', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000004', 'done')]));
    mount(); await findChainRow();
    expectUnfinishedCounts(0, 0);
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expectUnfinishedCounts(0, 0);
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    expectUnfinishedCounts(0, 0);
  });

  it('updates the chain claim indicator through project sync without per-row reads', async () => {
    const child = canonicalTask(2);
    const claim: WorkerClaim = { claimId: canonicalTask(201), state: 'active', userId: canonicalTask(202), workerId: canonicalTask(203), machine: { id: canonicalTask(204), name: 'host' }, platform: 'linux', agent: 'codex', agentControlMode: 'web', worktreeId: canonicalTask(205), phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: timestamp };
    workerClaims.set(child, claim);
    graphRequest.mockResolvedValue(snapshot(seeds.map((task) => task.id === child ? { ...task, status: 'in_progress', startedAt: timestamp } : task)));
    mount(); const header = await findChainRow();
    expect(header).toHaveAccessibleName(/自动执行中/);
    expect(graphRequest).toHaveBeenCalledTimes(1);
    expect(getTask).not.toHaveBeenCalled();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header).toHaveAccessibleName(/自动执行中/);
    expect(graphRequest).toHaveBeenCalledTimes(1);
    expect(getTask).not.toHaveBeenCalled();
    workerClaims.delete(child);
    graphRequest.mockResolvedValue(snapshot());
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(header).not.toHaveAccessibleName(/自动执行中/));
    expect(graphRequest).toHaveBeenCalledTimes(2);
    expect(getTask).not.toHaveBeenCalled();
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('updates counts and categories from one successful snapshot and retains them while refreshing or after failure', async () => {
    let resolve!: (value: TaskGraph) => void;
    const refreshed = new Promise<TaskGraph>((done) => { resolve = done; });
    graphRequest.mockResolvedValueOnce(snapshot()).mockReturnValueOnce(refreshed).mockRejectedValueOnce(new Error('Refresh failed'));
    mount(); await findTab('standalone');
    fireEvent.click(tab('standalone'));
    expectUnfinishedCounts(1, 2);
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    expect(titleActions().getByRole('button', { name: '正在刷新…' })).toBeDisabled();
    expect(row('00000000-0000-4000-8000-000000000003')).toBeVisible(); expect(row('00000000-0000-4000-8000-000000000005')).toBeVisible();
    expectUnfinishedCounts(1, 2);
    await act(async () => { resolve(snapshot([
      seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000003', 'todo', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000004', 'done'), seed('00000000-0000-4000-8000-000000000005', 'in_progress', ['00000000-0000-4000-8000-000000000001']),
    ])); });
    await waitFor(() => expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000003')).toBeNull());
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000005')).toBeNull();
    expectUnfinishedCounts(3, 0);
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '刷新失败' });
    expect(await screen.findByText('任务 00000000-0000-4000-8000-000000000004')).toBeVisible();
    expectUnfinishedCounts(3, 0);
    fireEvent.click(tab('chains'));
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expectUnfinishedCounts(3, 0);
  });

  it('updates assignee counts after a topology and ownership refresh while retaining the last snapshot on failure', async () => {
    const goal = canonicalTask(500), first = canonicalTask(1), second = canonicalTask(2), third = canonicalTask(3), fourth = canonicalTask(4);
    const other = canonicalTask(900);
    const initial = snapshot([
      { ...seed(goal, 'done'), type: 'goal', assignedTo: TEST_VIEWER_ID },
      { ...seed(first, 'done'), assignedTo: TEST_VIEWER_ID }, { ...seed(second, 'todo', [first]), assignedTo: other },
      { ...seed(third), assignedTo: TEST_VIEWER_ID }, { ...seed(fourth), assignedTo: other },
    ]);
    const changed = snapshot([
      { ...seed(goal, 'done'), type: 'goal', assignedTo: other },
      { ...seed(first, 'done'), assignedTo: TEST_VIEWER_ID }, { ...seed(second, 'todo', [first]), parentId: goal, assignedTo: TEST_VIEWER_ID },
      { ...seed(third, 'todo', [first]), assignedTo: TEST_VIEWER_ID }, { ...seed(fourth), assignedTo: TEST_VIEWER_ID },
    ]);
    let resolve!: (value: TaskGraph) => void;
    const pending = new Promise<TaskGraph>((done) => { resolve = done; });
    graphRequest.mockResolvedValueOnce(initial).mockReturnValueOnce(pending).mockRejectedValueOnce(new Error('Refresh failed')).mockResolvedValue(changed);
    let changeAssignee!: Parameters<typeof TaskAssigneeFilterModule.TaskAssigneeFilter>[0]['onChange'];
    const ActualFilter = TaskAssigneeFilterModule.TaskAssigneeFilter;
    vi.spyOn(TaskAssigneeFilterModule, 'TaskAssigneeFilter').mockImplementation((props) => { changeAssignee = props.onChange; return <ActualFilter {...props} />; });
    mount(); await findTab('chains'); act(() => changeAssignee({ kind: 'me' }));
    const goalCount = () => tab('goals').querySelector('.graph-count-pill');
    expectUnfinishedCounts(0, 1); expect(goalCount()).toHaveTextContent(/^1$/);
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    expectUnfinishedCounts(0, 1); expect(goalCount()).toHaveTextContent(/^1$/);
    await act(async () => { resolve(initial); });
    await waitFor(() => expect(titleActions().getByRole('button', { name: '刷新' })).toBeEnabled());
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '刷新失败' });
    expectUnfinishedCounts(0, 1); expect(goalCount()).toHaveTextContent(/^1$/);
    fireEvent.click(screen.getByRole('button', { name: '重试刷新' }));
    await waitFor(() => expectUnfinishedCounts(1, 1));
    expect(goalCount()).toHaveTextContent(/^0$/);
  });

  it('opens the real dialog directly and returns focus to its standalone row', async () => {
    graphRequest.mockResolvedValue(snapshot([seed(canonicalTask(3))]));
    mount(); await findTab('standalone');
    const { trigger, dialog } = await openStandalone(canonicalTask(3));
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(root).toHaveAttribute('inert');
    expect(within(dialog.querySelector<HTMLElement>('.task-detail-header-actions')!).getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(root).not.toHaveAttribute('inert');
  });

  it('uses roving tab focus with wrapping arrows, Home and End without requesting another snapshot', async () => {
    mount(); await findTab('chains'); tab('chains').focus();
    fireEvent.keyDown(tab('chains'), { key: 'ArrowRight' });
    expect(tab('goals')).toHaveFocus();
    fireEvent.keyDown(tab('goals'), { key: 'ArrowRight' });
    expect(tab('standalone')).toHaveFocus(); expect(tab('standalone')).toHaveAttribute('tabindex', '0');
    expect(tab('chains')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: '独立任务' })).toBeVisible();
    fireEvent.keyDown(tab('standalone'), { key: 'ArrowLeft' }); expect(tab('goals')).toHaveFocus();
    fireEvent.keyDown(tab('chains'), { key: 'Home' }); expect(tab('standalone')).toHaveFocus();
    fireEvent.keyDown(tab('standalone'), { key: 'End' }); expect(tab('goals')).toHaveFocus();
    tab('chains').focus();
    fireEvent.keyDown(tab('chains'), { key: 'ArrowDown' }); expect(tab('chains')).toHaveFocus();
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('remembers the selected view while chain graphs reopen only after a click', async () => {
    let view = mount(); await findTab('chains');
    await openChain(); closeChain();
    fireEvent.click(tab('standalone'));
    cleanup(); view = mount(); await findTab('standalone');
    expect(tab('standalone')).toHaveAttribute('aria-selected', 'true');
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    fireEvent.click(tab('chains')); expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(window.localStorage.getItem(key('project-view'))).toBeNull();
    act(() => browserNavigation().navigate(`/projects/${otherProject}`));
    view.rerender(<ProjectPage projectId={otherProject} />); selectTasks(); await screen.findByRole('heading', { name: otherProject }); await waitForGraph();
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
  });

  it('shares one scroll position across categories without restoring on switches, and isolates project visits', async () => {
    let scroll = 0;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    let view = mount(); await findTab('chains');
    vi.mocked(window.scrollTo).mockClear();
    scroll = 320; fireEvent.scroll(window); fireEvent.click(tab('standalone'));
    expect(scroll).toBe(320);
    scroll = 540; fireEvent.scroll(window); fireEvent.click(tab('chains'));
    expect(scroll).toBe(540);
    fireEvent.keyDown(tab('chains'), { key: 'ArrowRight' });
    expect(tab('goals')).toHaveFocus();
    expect(scroll).toBe(540);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(key('task-list-scroll'))!)).toBe(540);
    cleanup(); view = mount(); await findTab('standalone');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'instant' });
    act(() => browserNavigation().navigate(`/projects/${otherProject}`));
    view.rerender(<ProjectPage projectId={otherProject} />); selectTasks(); await screen.findByRole('heading', { name: otherProject }); await waitForGraph();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    scroll = 120; fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem(key('task-list-scroll', otherProject))!)).toBe(120);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />); await findTab('standalone');
    expect(scroll).toBe(540);
  });

  it('ignores obsolete category scroll records when entering the task list', async () => {
    window.localStorage.setItem(key('task-view-scroll'), JSON.stringify({ chains: 320, standalone: 540 }));
    const read = vi.spyOn(Storage.prototype, 'getItem');
    mount(); await findTab('chains');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    expect(read).not.toHaveBeenCalledWith(key('task-view-scroll'));
  });

  it('distinguishes absent categories, completed rows and an entirely empty project', async () => {
    graphRequest.mockResolvedValueOnce(snapshot([seed('00000000-0000-4000-8000-000000000004', 'done')])).mockResolvedValueOnce(resetSnapshot(snapshot([])));
    mount(); await screen.findByRole('heading', { name: '暂无任务链' });
    expectUnfinishedCounts(0, 0);
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' })); await screen.findByRole('heading', { name: '暂无独立任务' });
    expect(tab('chains')).toBeVisible();
    fireEvent.click(tab('goals'));
    expect(screen.getByRole('heading', { name: '暂无 Goal' })).toBeVisible();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps details when refresh adds an edge and returns focus to the active category tab when its row vanishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    graphRequest.mockResolvedValueOnce(snapshot([seed(canonicalTask(3))])).mockResolvedValueOnce(snapshot([seed(canonicalTask(3)), seed(canonicalTask(4), 'todo', [canonicalTask(3)])]));
    mount(); await findTab('standalone'); const { trigger, dialog } = await openStandalone(canonicalTask(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await screen.findByRole('heading', { name: '暂无独立任务' });
    expectUnfinishedCounts(2, 0);
    expect(trigger.isConnected).toBe(false); expect(dialog).toBeVisible();
    expect(getTask).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(tab('standalone')).toHaveFocus());
    fireEvent.click(tab('chains'));
    expect(chainGraphButton(canonicalTask(3))).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByTestId('graph-node')).toBeNull();
  });

  it('keeps details while refresh removes an edge and falls back to the still-active chain tab', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    graphRequest.mockResolvedValueOnce(snapshot([seed(canonicalTask(1)), seed(canonicalTask(2), 'todo', [canonicalTask(1)])])).mockResolvedValueOnce(snapshot([seed(canonicalTask(1)), seed(canonicalTask(2))]));
    mount(); fireEvent.click(await openChain());
    await waitFor(() => expect(document.querySelector('.task-detail-dialog')).toBeVisible());
    const dialog = document.querySelector<HTMLElement>('.task-detail-dialog')!;
    await within(dialog.querySelector<HTMLElement>('.task-detail-header')!).findByRole('heading', { name: `任务 ${canonicalTask(1)}` });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await screen.findByRole('heading', { name: '暂无任务链' }); expect(dialog).toBeVisible();
    expectUnfinishedCounts(0, 2);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); await waitFor(() => expect(tab('chains')).toHaveFocus());
    fireEvent.click(tab('standalone')); expect(row(canonicalTask(1))).toBeVisible(); expect(row(canonicalTask(2))).toBeVisible();
  });
});

const newPreferences = [
  ['task-view', '"invalid"', /^浏览器保存的任务页签无效/],
  ['task-list-scroll', '-1', /^浏览器保存的任务浏览位置无效/],
] as const;

describe('task view storage failures', () => {
  it.each(['null', '{}', '[]', 'true', '"320"', '1e999'])('rejects a non-finite or nonnumeric task-list offset %s', async (value) => {
    window.localStorage.setItem(key('task-list-scroll'), value);
    mount(); await findTab('chains');
    expect(screen.getByText(/^浏览器保存的任务浏览位置无效/)).toBeVisible();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
  });

  it.each(newPreferences)('rejects invalid %s data while preserving usable defaults', async (kind, value, notice) => {
    window.localStorage.setItem(key(kind), value); mount(); await findTab('chains');
    expect(screen.getByText(notice)).toBeVisible(); expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('standalone')); expect(row('00000000-0000-4000-8000-000000000003')).toBeVisible();
  });

  it('reports each unreadable preference independently and keeps all controls usable', async () => {
    const read = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (newPreferences.some(([kind]) => name === key(kind))) throw new DOMException('Denied', 'SecurityError');
      return read.call(this, name);
    });
    mount(); await findTab('chains');
    expect(screen.getByText(/^无法读取浏览器保存的任务页签/)).toBeVisible();
    expect(screen.getByText(/^无法读取浏览器保存的任务浏览位置/)).toBeVisible();
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
  });

  it('applies choices after failed writes and clears each write notice when persistence recovers', async () => {
    let scroll = 0; vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    const write = Storage.prototype.setItem;
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (newPreferences.some(([kind]) => name === key(kind))) throw new DOMException('Full', 'QuotaExceededError');
      write.call(this, name, value);
    });
    mount(); await findTab('chains');
    scroll = 100; fireEvent.scroll(window); fireEvent.click(tab('standalone'));
    expect(screen.getByText(/^任务页签无法保存到浏览器/)).toBeVisible();
    expect(screen.getByText(/^任务浏览位置无法保存到浏览器/)).toBeVisible();
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    fail.mockRestore(); scroll = 200; fireEvent.scroll(window); fireEvent.click(tab('chains'));
    expect(screen.queryByText(/^任务页签无法保存到浏览器/)).toBeNull();
    expect(screen.queryByText(/^任务浏览位置无法保存到浏览器/)).toBeNull();
  });
});


describe('project overview and task workspace', () => {
  const mountOverview = () => {
    if (!root.isConnected) document.body.append(root);
    return render(<ProjectPage projectId={project} />, { container: root });
  };
  const progressButton = (title: string) => overviewProgress().getByRole('button', { name: new RegExp(title) });
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn<(this: HTMLElement, options?: ScrollIntoViewOptions) => void>();
  beforeEach(() => {
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  });
  afterEach(() => {
    if (originalScrollIntoView === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  });

  it('locates an overview chain after switching from the saved standalone category and overrides the shared scroll position', async () => {
    window.localStorage.setItem(key('task-view'), '"standalone"');
    window.localStorage.setItem(key('task-list-scroll'), '320');
    let scroll = 0;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    scrollIntoView.mockImplementation(function (this: HTMLElement) { expect(this.id).toBe(`task-root-${canonicalTask(1)}`); scroll = 760; });
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    scroll = 90;
    fireEvent.click(progressButton(`任务 ${canonicalTask(1)}`));
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    expect(chainRow()).toHaveFocus();
    expect(chainRow()).toHaveClass('overview-progress-target');
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', behavior: 'instant' });
    expect(scroll).toBe(760);
    expect(JSON.parse(window.localStorage.getItem(key('task-list-scroll'))!)).toBe(760);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    fireEvent.click(sectionTab('overview'));
    expect(scroll).toBe(90);
    fireEvent.click(sectionTab('tasks'));
    expect(scroll).toBe(760);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it('clears a status filter that only matches a different Goal scope before locating an overview chain', async () => {
    const rootId = canonicalTask(1), childId = canonicalTask(2), goalId = canonicalTask(3);
    graphRequest.mockResolvedValue(snapshot([
      seed(rootId, 'done'), { ...seed(childId, 'todo', [rootId]), parentId: goalId }, { ...seed(goalId), type: 'goal' },
    ]));
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    fireEvent.change(filters().getByRole('combobox', { name: '状态' }), { target: { value: 'todo' } });
    expect(chainRow(rootId)).toBeNull();
    fireEvent.click(sectionTab('overview'));
    fireEvent.click(progressButton(`任务 ${rootId}`));
    expect(filters().getByRole('combobox', { name: '状态' })).toHaveValue('all');
    expect(chainRow(rootId)).toBeVisible();
    expect(chainRow(rootId)).toHaveFocus();
    expect(screen.queryByText('无法定位所选任务')).toBeNull();
  });

  it('locates the standalone list from its overview aggregate and expires the temporary highlight', async () => {
    let scroll = 0;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    scrollIntoView.mockImplementation(function (this: HTMLElement) { expect(this.id).toBe('project-task-panel-standalone'); scroll = 240; });
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(progressButton('独立任务'));
    const target = document.getElementById('project-task-panel-standalone')!;
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(tab('standalone')).toHaveAttribute('aria-selected', 'true');
    expect(target).toHaveFocus();
    expect(target).toHaveClass('overview-progress-target');
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'start', behavior: 'instant' });
    expect(JSON.parse(window.localStorage.getItem(key('task-list-scroll'))!)).toBe(240);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => vi.advanceTimersByTime(2_200));
    expect(target).not.toHaveClass('overview-progress-target');
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it('clears a previous navigation highlight when locating another group and on unmount', async () => {
    const view = mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(progressButton(`任务 ${canonicalTask(1)}`));
    const previousTarget = chainRow();
    expect(previousTarget).toHaveClass('overview-progress-target');
    fireEvent.click(sectionTab('overview'));
    fireEvent.click(progressButton('独立任务'));
    const target = document.getElementById('project-task-panel-standalone')!;
    expect(previousTarget).not.toHaveClass('overview-progress-target');
    expect(target).toHaveClass('overview-progress-target');
    view.unmount();
    expect(target).not.toHaveClass('overview-progress-target');
  });

  const interceptOverviewNavigation = () => {
    let navigate!: Parameters<typeof ProjectOverviewModule.ProjectOverview>[0]['onNavigate'];
    const ActualOverview = ProjectOverviewModule.ProjectOverview;
    vi.spyOn(ProjectOverviewModule, 'ProjectOverview').mockImplementation((props) => {
      navigate = props.onNavigate;
      return <ActualOverview {...props} />;
    });
    return () => navigate;
  };

  it('resolves a retained overview task witness against its latest representative without reopening the graph or repeating navigation', async () => {
    const getNavigate = interceptOverviewNavigation();
    const state = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(seeds, 1), status: 'ready' as const, refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const view = mountOverview();
    const navigate = getNavigate();
    state.snapshot = mockNavigationSnapshot([seed(canonicalTask(0), 'done'), seed(canonicalTask(1), 'done', [canonicalTask(0)]), ...seeds.slice(1)], 2);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    act(() => navigate({ kind: 'chain', taskId: canonicalTask(1) }));
    expect(chainRow(canonicalTask(0))).toHaveFocus();
    expect(chainRow(canonicalTask(0))).toHaveClass('overview-progress-target');
    expect(chainRow()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    state.snapshot = mockNavigationSnapshot([...state.snapshot.graph.tasks, seed(canonicalTask(9))], 3);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it.each([
    ['removed', seeds.slice(2)],
    ['standalone', [seeds[0]!, ...seeds.slice(2)]],
  ])('keeps the requested category focused when the overview chain is %s before navigation', async (_name, tasks) => {
    const getNavigate = interceptOverviewNavigation();
    const state = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(seeds, 1), status: 'ready' as const, refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const view = mountOverview();
    const navigate = getNavigate();
    state.snapshot = mockNavigationSnapshot(tasks, 2);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    act(() => navigate({ kind: 'chain', taskId: canonicalTask(1) }));
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(tab('chains')).toHaveFocus();
    expect(screen.getByText('对应的任务分组已不可见，请从任务列表选择任务。')).toBeVisible();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(key('completed-chains'))).toBeNull();
    expect(window.localStorage.getItem(key('completed-standalone-tasks'))).toBeNull();
  });

  it('locates a chain completed after the overview was rendered', () => {
    const getNavigate = interceptOverviewNavigation();
    const state = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(seeds, 1), status: 'ready' as const, refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const view = mountOverview();
    const navigate = getNavigate();
    state.snapshot = mockNavigationSnapshot([seeds[0]!, seed(canonicalTask(2), 'done', [canonicalTask(1)]), ...seeds.slice(2)], 2);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    act(() => navigate({ kind: 'chain', taskId: canonicalTask(1) }));
    expect(chainRow()).toHaveFocus();
    expect(chainRow()).toHaveClass('overview-progress-target');
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('consumes an overview target when project access disappears and returns focus to the visible Tasks section', () => {
    const getNavigate = interceptOverviewNavigation();
    let state: ReturnType<typeof TaskGraphModule.useTaskGraph> = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(seeds, 1), status: 'ready', refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const view = mountOverview();
    const navigate = getNavigate();
    state = { ...state, snapshot: null, status: 'error', error: new ApiError('server', 404, 'not_found', 'missing-project') };
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    act(() => navigate({ kind: 'chain', taskId: canonicalTask(1) }));
    expect(sectionTab('tasks')).toHaveFocus();
    expect(screen.getByRole('heading', { name: '项目不存在' })).toBeVisible();
    expect(scrollIntoView).not.toHaveBeenCalled();
    state = { ...state, snapshot: mockNavigationSnapshot(seeds, 3), status: 'ready', error: null };
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('defaults to Overview and restores Tasks directly on remount with its separate scroll position', async () => {
    window.localStorage.setItem(key('task-list-scroll'), '320');
    let scroll = 80;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(window.localStorage.getItem(key('project-section'))).toBeNull();
    expect(screen.getByRole('region', { name: '项目任务统计' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: '任务链' })).toBeNull();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(scroll).toBe(0);
    scroll = 90; fireEvent.scroll(window); fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem(key('task-list-scroll'))!)).toBe(320);
    fireEvent.click(sectionTab('tasks'));
    const chain = await findChainRow();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(scroll).toBe(320);
    scroll = 400; fireEvent.scroll(window);
    fireEvent.click(sectionTab('overview'));
    expect(scroll).toBe(90);
    expect(chain.isConnected).toBe(true);
    expect(chain).not.toBeVisible();
    expect(document.getElementById('project-section-panel-tasks')).toHaveAttribute('inert');
    scroll = 120; fireEvent.scroll(window); fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem(key('task-list-scroll'))!)).toBe(400);
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBe(chain);
    expect(scroll).toBe(400);
    fireEvent.click(sectionTab('tasks'));
    expect(graphRequest).toHaveBeenCalledOnce();
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(scroll).toBe(400);
  });

  it('navigates to Tags, retains the task view, and restores the section preference', async () => {
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    await findChainRow();
    fireEvent.click(tab('standalone'));
    fireEvent.click(sectionTab('tags'));
    expect(screen.getByTestId('project-tags')).toHaveTextContent(project);
    expect(sectionTab('tags')).toHaveAttribute('aria-selected', 'true');
    expect(window.localStorage.getItem(key('project-section'))).toBe('"tags"');
    expect(readProjectHistory(browserNavigation().snapshot().view, TEST_VIEWER_ID, project)?.section).toBe('tags');
    fireEvent.click(sectionTab('tasks'));
    expect(tab('standalone')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('project-tags')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('project-tags')).not.toBeVisible();
    fireEvent.click(sectionTab('tags'));
    expect(screen.getByTestId('project-tags')).toHaveAttribute('data-active', 'true');
    cleanup();
    mountOverview();
    expect(sectionTab('tags')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('project-tags')).toHaveTextContent(project);
  });

  it('restores the shared offset after the initial snapshot renders the visible task workspace', async () => {
    window.localStorage.setItem(key('project-section'), '"tasks"');
    window.localStorage.setItem(key('task-list-scroll'), '320.5');
    let resolve!: (value: TaskGraph) => void;
    graphRequest.mockReturnValueOnce(new Promise<TaskGraph>((done) => { resolve = done; }));
    vi.mocked(window.scrollTo).mockImplementation(() => { expect(chainRow()).toBeVisible(); });
    mountOverview();
    expect(window.scrollTo).not.toHaveBeenCalled();
    await act(async () => { resolve(snapshot()); });
    await findChainRow();
    expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 320.5, behavior: 'instant' });
  });

  it('mounts a task workspace only after its first visible usable snapshot', async () => {
    let resolve!: (value: TaskGraph) => void;
    let scroll = 64;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    graphRequest.mockReturnValueOnce(new Promise<TaskGraph>((done) => { resolve = done; }));
    mountOverview();
    fireEvent.click(sectionTab('tasks'));
    fireEvent.click(sectionTab('overview'));
    await act(async () => { resolve(snapshot()); });
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(scroll).toBe(0);
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(screen.queryByRole('tab', { name: '任务链', hidden: true })).toBeNull();
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it('updates Overview from the same synchronization while Tasks are hidden and clears private children on trusted removal', async () => {
    graphRequest.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([...seeds, seed(canonicalTask(9))]))
      .mockRejectedValueOnce(new ApiError('server', 404, 'not_found', 'missing-project')).mockResolvedValueOnce(snapshot());
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    const chain = await findChainRow();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    fireEvent.click(sectionTab('overview'));
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '项目任务统计' }).querySelector('.stat-number')).toHaveTextContent('6'));
    expect(chainRow()).toBe(chain);
    expect(chain).not.toBeVisible();
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '项目不存在' });
    expect(chain.isConnected).toBe(false);
    expect(screen.queryByRole('tab', { name: '任务链', hidden: true })).toBeNull();
    expect(screen.queryByRole('region', { name: '项目任务统计', hidden: true })).toBeNull();
    fireEvent.click(within(document.getElementById('project-section-panel-overview')!).getByRole('button', { name: '重试' }));
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(graphRequest).toHaveBeenCalledTimes(4);
  });

  it('returns detail focus to the visible outer view instead of a retained hidden task trigger', async () => {
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    const { trigger, dialog } = await openStandalone(canonicalTask(3));
    fireEvent.click(sectionTab('overview'));
    expect(trigger.isConnected).toBe(true);
    fireEvent.click(within(dialog.querySelector<HTMLElement>('.task-detail-header-actions')!).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(sectionTab('overview')).toHaveFocus());
    expect(trigger).not.toHaveFocus();
    expect(screen.getByRole('region', { name: '项目任务统计' })).toBeVisible();
  });

  it('keeps each project selection independent and restores a saved Overview on remount', async () => {
    graphRequest.mockImplementation(async (id) => snapshot([], id));
    const view = mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    fireEvent.click(sectionTab('tasks'));
    expect(screen.getByRole('heading', { name: '暂无任务链' })).toBeVisible();
    act(() => browserNavigation().navigate(`/projects/${otherProject}`));
    view.rerender(<ProjectPage projectId={otherProject} />);
    await screen.findByRole('heading', { name: otherProject }); await waitForGraph();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: '还没有任务' })).toBeVisible();
    expect(screen.getByRole('region', { name: '项目任务统计' })).toBeVisible();
    expect(window.localStorage.getItem(key('project-section', otherProject))).toBeNull();
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(screen.getByRole('heading', { name: '暂无任务链' })).toBeVisible();
    fireEvent.click(sectionTab('overview'));
    expect(window.localStorage.getItem(key('project-section'))).toBe('"overview"');
    cleanup();
    mountOverview();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    expect(screen.getByRole('heading', { name: '还没有任务' })).toBeVisible();
  });

  it.each(['"standalone"', 'null', '{}', '["tasks"]', 'tasks'])('rejects invalid outer section %s and remains usable', async (value) => {
    window.localStorage.setItem(key('project-section'), value);
    mountOverview();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^浏览器保存的项目视图无效，已默认显示概览/)).toBeVisible();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(window.localStorage.getItem(key('project-section'))).toBe('"tasks"');
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/^浏览器保存的项目视图无效/)).toBeNull();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
  });

  it('reports an unreadable outer section and recovers from the next successful read', async () => {
    window.localStorage.setItem(key('project-section'), '"tasks"');
    const read = Storage.prototype.getItem;
    const failedRead = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (name === key('project-section')) throw new DOMException('Denied', 'SecurityError');
      return read.call(this, name);
    });
    mountOverview();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^无法读取浏览器保存的项目视图/)).toBeVisible();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    failedRead.mockRestore();
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/^无法读取浏览器保存的项目视图/)).toBeNull();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
  });

  it('keeps the current outer section after a failed write and clears its notice after a successful save', async () => {
    const write = Storage.prototype.setItem;
    const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (name === key('project-section')) throw new DOMException('Full', 'QuotaExceededError');
      write.call(this, name, value);
    });
    mountOverview();
    await screen.findByRole('heading', { name: project }); await waitForGraph();
    fireEvent.click(sectionTab('tasks'));
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(screen.getByText(/^项目视图无法保存到浏览器/)).toBeVisible();
    expect(window.localStorage.getItem(key('project-section'))).toBeNull();
    failedWrite.mockRestore();
    fireEvent.click(sectionTab('overview'));
    expect(screen.queryByText(/^项目视图无法保存到浏览器/)).toBeNull();
    expect(window.localStorage.getItem(key('project-section'))).toBe('"overview"');
    fireEvent.click(sectionTab('tasks'));
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project }); await waitForGraph();
  });
});

describe('recent task browsing and pagination', () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
  afterEach(() => {
    if (originalScrollIntoView === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  });
  const pagination = (name: '任务链列表' | '独立任务列表' | '整体进度') => within(document.getElementById({
    '任务链列表': 'project-chain-list', '独立任务列表': 'project-standalone-list', '整体进度': 'project-overview-progress',
  }[name])!).getByRole('navigation', { name: `${name}分页` });
  const manyChains = (count: number) => Array.from({ length: count }, (_, position) => {
    const root = canonicalTask(position * 2 + 1);
    return [seed(root), seed(canonicalTask(position * 2 + 2), 'todo', [root])];
  }).flat();
  const manyStandalone = (count: number) => Array.from({ length: count }, (_, position) => seed(canonicalTask(1_000 + position)));

  it('shows old completions in both lists without changing the recent overview', async () => {
    const completed = (value: number, when: string, dependsOn: string[] = []) => ({ ...seed(canonicalTask(value), 'done', dependsOn), completedAt: when });
    graphRequest.mockResolvedValue(snapshot([
      completed(1, '2026-10-01T10:00:00Z'), completed(2, '2026-10-19T10:00:00Z', [canonicalTask(1)]),
      completed(3, '2026-10-01T10:00:00Z'), completed(4, '2026-10-10T12:00:00Z', [canonicalTask(3)]),
      completed(5, '2026-10-19T10:00:00Z'), completed(6, '2026-10-10T12:00:00Z'),
    ]));
    mount(); await findChainRow(canonicalTask(1));
    expect(chainRow(canonicalTask(3))).toBeVisible();
    expect(chainRow(canonicalTask(1)).closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('已完成');
    fireEvent.click(tab('standalone'));
    expect(row(canonicalTask(5))).toBeVisible();
    expect(row(canonicalTask(6))).toBeVisible();
    fireEvent.click(sectionTab('overview'));
    const overview = screen.getByRole('region', { name: '整体进度' });
    expect(within(overview).getAllByRole('button')).toHaveLength(2);
    expect(within(overview).getByRole('button', { name: new RegExp(canonicalTask(1)) })).toHaveTextContent('100%');
    expect(within(overview).getByRole('button', { name: /^独立任务，/ })).toHaveTextContent('1 / 1');
  });

  it.each((['standalone', 'chains'] as const).flatMap((category) => [0, 1, 20, 21, 40, 41].map((count) => [category, count] as const)))('paginates %s with %i entries without losing or repeating entries', async (category, count) => {
    graphRequest.mockClear();
    graphRequest.mockResolvedValue(snapshot(category === 'standalone' ? manyStandalone(count) : manyChains(count)));
    mount(); await screen.findByRole('heading', { name: project }); await waitForGraph();
    if (count === 0) {
      expect(tab('goals')).toBeVisible();
      expect(document.querySelectorAll('.standalone-row, .goal-toggle')).toHaveLength(0);
      return;
    }
    fireEvent.click(tab(category));
    const selector = category === 'standalone' ? '.standalone-row' : '.goal-toggle';
    const label = category === 'standalone' ? '独立任务列表' : '任务链列表';
    const seen: string[] = [];
    const pageCount = Math.ceil(count / 20);
    for (let page = 1; page <= pageCount; page++) {
      const entries = [...document.querySelectorAll(selector)];
      expect(entries).toHaveLength(Math.min(20, count - (page - 1) * 20));
      seen.push(...entries.map((entry) => entry.id));
      if (pageCount === 1) expect(screen.queryByRole('navigation', { name: `${label}分页` })).toBeNull();
      else {
        const controls = pagination(label);
        expect(controls).toHaveTextContent(`第 ${(page - 1) * 20 + 1}–${Math.min(page * 20, count)} 条，共 ${count} 条`);
        expect(within(controls).getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(page === 1);
        const nextPage = within(controls).getByRole('button', { name: '下一页' });
        expect(nextPage.hasAttribute('disabled')).toBe(page === pageCount);
        if (page < pageCount) fireEvent.click(nextPage);
      }
    }
    expect(new Set(seen).size).toBe(count);
    if (pageCount > 1) {
      fireEvent.click(tab(category === 'standalone' ? 'chains' : 'standalone')); fireEvent.click(tab(category));
      expect(pagination(label)).toHaveTextContent(`第 ${pageCount} / ${pageCount} 页`);
      fireEvent.change(filters().getByRole('combobox', { name: '状态' }), { target: { value: 'todo' } });
      expect(pagination(label)).toHaveTextContent(`第 1 / ${pageCount} 页`);
    }
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('counts the standalone overview aggregate as one row and navigates to a Goal on another task-list page', async () => {
    graphRequest.mockResolvedValue(snapshot([...manyChains(21), ...manyStandalone(25)]));
    mount(); await findChainRow(canonicalTask(41));
    fireEvent.click(within(pagination('任务链列表')).getByRole('button', { name: '下一页' }));
    expect(chainRow(canonicalTask(1))).toBeVisible();
    fireEvent.click(tab('standalone'));
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    fireEvent.click(sectionTab('overview'));
    const overview = screen.getByRole('region', { name: '整体进度' });
    expect(overview.querySelectorAll('.overview-progress-row')).toHaveLength(20);
    fireEvent.click(within(pagination('整体进度')).getByRole('button', { name: '下一页' }));
    expect(overview.querySelectorAll('.overview-progress-row')).toHaveLength(2);
    expect(within(overview).getByRole('button', { name: /^独立任务，/ })).toHaveTextContent('0 / 25');
    fireEvent.click(within(overview).getByRole('button', { name: new RegExp(canonicalTask(1)) }));
    expect(pagination('任务链列表')).toHaveTextContent('第 2 / 2 页');
    expect(chainRow(canonicalTask(1))).toHaveFocus();
    fireEvent.click(sectionTab('overview'));
    expect(pagination('整体进度')).toHaveTextContent('第 2 / 2 页');
    fireEvent.click(within(overview).getByRole('button', { name: /^独立任务，/ }));
    expect(pagination('独立任务列表')).toHaveTextContent('第 1 / 2 页');
  });

  it('moves to the target Goal page when the task list was left on another page', async () => {
    graphRequest.mockResolvedValue(snapshot(manyChains(21)));
    mount(); await findChainRow(canonicalTask(41));
    fireEvent.click(sectionTab('overview'));
    fireEvent.click(within(pagination('整体进度')).getByRole('button', { name: '下一页' }));
    fireEvent.click(overviewProgress().getByRole('button', { name: new RegExp(`${canonicalTask(1)}，已完成`) }));
    expect(chainRow(canonicalTask(1))).toHaveFocus();
    expect(pagination('任务链列表')).toHaveTextContent('第 2 / 2 页');
  });

  it.each([
    ['all', 'all'], ['todo', 'all'], ['all', 'unassigned'], ['todo', 'unassigned'],
    ['in_progress', 'all'], ['done', 'all'], ['cancelled', 'all'],
  ] as const)('keeps status %s and assignee %s list state across repeated external Goal navigation', async (status, assignee) => {
    const targetStatus = status === 'done' ? 'cancelled' as const : 'done' as const;
    const finished = manyChains(21).map((task) => ({ ...task, status: targetStatus,
      assignedTo: assignee === 'unassigned' ? canonicalTask(900) : null,
      ...(task.id === canonicalTask(2) ? { dependsOn: [canonicalTask(1), canonicalTask(4)], externalDependsOn: [canonicalTask(4)] } : {}),
    }));
    const source = canonicalTask(100);
    const dependency = canonicalTask(2);
    let changeAssignee!: Parameters<typeof TaskAssigneeFilterModule.TaskAssigneeFilter>[0]['onChange'];
    if (assignee === 'unassigned') {
      const ActualFilter = TaskAssigneeFilterModule.TaskAssigneeFilter;
      vi.spyOn(TaskAssigneeFilterModule, 'TaskAssigneeFilter').mockImplementation((props) => {
        changeAssignee = props.onChange;
        return <ActualFilter {...props} />;
      });
    }
    const sourceStatus = status === 'all' ? 'todo' : status;
    graphRequest.mockResolvedValue(snapshot([...finished, seed(source, sourceStatus === 'in_progress' ? 'done' : sourceStatus), seed(canonicalTask(101), sourceStatus, [source, dependency], [dependency])]));
    mount(); await findChainRow(source);
    const statusControl = filters().getByRole('combobox', { name: '状态' });
    fireEvent.change(statusControl, { target: { value: status } });
    if (assignee === 'unassigned') act(() => changeAssignee({ kind: 'unassigned' }));
    const assigneeControl = filters().getByRole('button', { name: `负责人: ${assignee === 'all' ? '所有负责人' : '未分配'}` });
    const rows = [...document.querySelectorAll('.root-toggle')];
    const page = document.querySelector('#project-chain-list .list-pagination');
    const pageText = page?.textContent;
    const original = chainRow(source);
    const trigger = chainGraphButton(source);
    fireEvent.click(original);
    let scroll = 320;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    vi.mocked(window.scrollTo).mockClear();
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    await openChain(source);
    for (const [taskId, rootId] of [[dependency, canonicalTask(1)], [canonicalTask(4), canonicalTask(3)]]) {
      fireEvent.click(screen.getByTestId(`external-${taskId}`));
      await waitFor(() => expect(document.getElementById(`task-graph-${rootId}`)).toBeVisible());
      expect([...document.querySelectorAll('.root-toggle')]).toEqual(rows);
      rows.forEach((row, position) => expect(document.querySelectorAll('.root-toggle')[position]).toBe(row));
      expect(original).toHaveAttribute('aria-expanded', 'true');
      expect(statusControl).toHaveValue(status);
      expect(assigneeControl).toBeInTheDocument();
      expect(document.querySelector('#project-chain-list .list-pagination')).toBe(page);
      expect(page?.textContent).toBe(pageText);
      expect(scroll).toBe(320);
    }
    expect(document.getElementById(`task-graph-${source}`)).toBeNull();
    closeChain();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(original).toBeVisible();
    expect(original).toHaveAttribute('aria-expanded', 'true');
    expect(statusControl).toHaveValue(status);
    expect(assigneeControl).toBeVisible();
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    if (page !== null) expect(page).toHaveTextContent('第 1 / 2 页');
  });

  it('uses the original Goal witness for visible focus fallback after external hops and a representative change', async () => {
    const source = canonicalTask(100), first = canonicalTask(2), second = canonicalTask(4), replacement = canonicalTask(99);
    const initial = [seed(canonicalTask(1), 'done'), seed(first, 'done', [canonicalTask(1), second], [second]),
      seed(canonicalTask(3), 'done'), seed(second, 'done', [canonicalTask(3)]),
      seed(source), seed(canonicalTask(101), 'todo', [source, first], [first]),
      seed(canonicalTask(200)), seed(canonicalTask(201), 'todo', [canonicalTask(200)])];
    const refreshed = [seed(replacement), ...initial.map((task) => task.id === source ? { ...task, dependsOn: [replacement] } : task)];
    const state = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(initial, 1), status: 'ready' as const, refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const view = mount(); await openChain(source);
    const removed = chainGraphButton(source);
    fireEvent.click(screen.getByTestId(`external-${first}`));
    fireEvent.click(screen.getByTestId(`external-${second}`));
    state.snapshot = mockNavigationSnapshot(refreshed, 2);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    expect(removed.isConnected).toBe(false);
    expect(document.getElementById(`task-graph-${canonicalTask(3)}`)).toBeVisible();
    expect(document.querySelector('.root-toggle')).toBe(chainRow(canonicalTask(200)));
    closeChain();
    await waitFor(() => expect(chainRow(replacement)).toHaveFocus());
  });

  it('retains a Goal graph history witness through an incomplete cached preview', async () => {
    const goal = canonicalTask(500);
    const tasks = [{ ...seed(goal), type: 'goal' as const }];
    let state: ReturnType<typeof TaskGraphModule.useTaskGraph> = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(tasks, 1), status: 'ready', refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const first = localeRender(<ProjectPage projectId={project} />, { container: root, taskCache: { scope } });
    selectTasks(); fireEvent.click(tab('goals'));
    fireEvent.click(document.getElementById(`project-goal-graph-${goal}`)!);
    expect(document.getElementById(`task-graph-${goal}`)).toBeVisible();
    first.unmount(); root.remove(); root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    const preview = mockNavigationSnapshot([], 0);
    state = { ...state, snapshot: { ...preview, observedAt: null, receivedAt: null, revision: 0, localTime: Date.now() } };
    const second = localeRender(<ProjectPage projectId={project} />, { container: root, taskCache: { scope } });
    expect(readProjectHistory(browserNavigation().snapshot().view, TEST_VIEWER_ID, project)?.projectGraphWitness).toBe(goal);
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    state = { ...state, snapshot: mockNavigationSnapshot(tasks, 2) };
    second.rerender(<ProjectPage projectId={project} />);
    expect(document.getElementById(`task-graph-${goal}`)).toBeVisible();
    closeChain();
    await waitFor(() => expect(document.getElementById(`project-goal-graph-${goal}`)).toHaveFocus());
    second.unmount(); scope.dispose();
  });

  it('retains a historical Goal chain while its snapshot is pending and restores its list focus without an opener', async () => {
    const goal = canonicalTask(500), source = canonicalTask(1), child = canonicalTask(2);
    const tasks = [{ ...seed(goal), type: 'goal' as const }, { ...seed(source), parentId: goal },
      { ...seed(child, 'todo', [source]), parentId: goal }];
    let state: ReturnType<typeof TaskGraphModule.useTaskGraph> = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(tasks, 1), status: 'ready', refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const first = localeRender(<ProjectPage projectId={project} />, { container: root, taskCache: { scope } });
    selectTasks(); fireEvent.click(tab('goals'));
    const goalRow = document.querySelector<HTMLElement>(`[data-goal-id="${goal}"]`)!;
    fireEvent.click(goalRow.querySelector<HTMLButtonElement>('.goal-list-toggle')!);
    act(() => browserNavigation().setView(projectHistory(TEST_VIEWER_ID, project, { section: 'tasks', view: 'goals', projectGraphWitness: source, detail: null }), { replace: true }));
    await screen.findByTestId('graph-node');
    first.unmount();
    root.remove();
    root = document.createElement('div'); root.id = 'root'; document.body.append(root);

    state = { ...state, snapshot: null, status: 'loading' };
    const second = localeRender(<ProjectPage projectId={project} />, { container: root, taskCache: { scope } });
    expect(readProjectHistory(browserNavigation().snapshot().view, TEST_VIEWER_ID, project)?.projectGraphWitness).toBe(source);
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    state = { ...state, snapshot: mockNavigationSnapshot(tasks, 2), status: 'ready' };
    second.rerender(<ProjectPage projectId={project} />);
    await screen.findByTestId('graph-node');
    expect(document.querySelectorAll('.task-chain-dialog')).toHaveLength(1);
    closeChain();
    await waitFor(() => expect(document.querySelector(`[data-goal-id="${goal}"] .goal-list-toggle`)).toHaveFocus());
    second.unmount();
    scope.dispose();
  });

  it.each(['removed', 'singleton'] as const)('closes an external graph whose actual task becomes %s on refresh without reopening it', async (kind) => {
    const source = canonicalTask(100), dependency = canonicalTask(2);
    const initial = [seed(canonicalTask(1), 'done'), seed(dependency, 'done', [canonicalTask(1)]),
      seed(source), seed(canonicalTask(101), 'todo', [source, dependency], [dependency])];
    const refreshed = kind === 'singleton'
      ? initial.map((task) => task.id === dependency ? { ...task, dependsOn: [] } : task)
      : initial.filter((task) => task.id !== dependency).map((task) => task.id === canonicalTask(101) ? { ...task, dependsOn: [source], externalDependsOn: [] } : task);
    const state = { sessionStore: mockSessionStore(), snapshot: mockNavigationSnapshot(initial, 1), status: 'ready' as const, refreshing: false, error: null, refresh: vi.fn() };
    vi.spyOn(TaskGraphModule, 'useTaskGraph').mockImplementation(() => state);
    const view = mount(); await openChain(source);
    const trigger = chainGraphButton(source);
    fireEvent.click(screen.getByTestId(`external-${dependency}`));
    expect(document.getElementById(`task-graph-${canonicalTask(1)}`)).toBeVisible();
    state.snapshot = mockNavigationSnapshot(refreshed, 2);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    state.snapshot = mockNavigationSnapshot(initial, 3);
    act(() => browserNavigation().navigate(`/projects/${project}`));
    view.rerender(<ProjectPage projectId={project} />);
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
  });

  it('opens an external singleton in the task reader and releases the origin graph', async () => {
    const source = canonicalTask(1), dependency = canonicalTask(3);
    graphRequest.mockResolvedValue(snapshot([seed(source), seed(canonicalTask(2), 'todo', [source, dependency], [dependency]), seed(dependency)]));
    mount(); await openChain(source);
    const trigger = chainGraphButton(source);
    fireEvent.click(screen.getByTestId(`external-${dependency}`));
    await waitFor(() => expect(document.querySelector('.task-detail-title')).toHaveTextContent(`任务 ${dependency}`));
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    expect(getTask).toHaveBeenCalledWith(project, dependency, expect.anything(), expect.anything());
    vi.mocked(window.scrollTo).mockClear();
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    fireEvent.click(within(document.querySelector<HTMLElement>('.task-detail-dialog')!).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps a Goal list origin across external graph hops and a singleton detail', async () => {
    const goal = canonicalTask(500), source = canonicalTask(1), child = canonicalTask(2), external = canonicalTask(3), externalChild = canonicalTask(4), single = canonicalTask(5);
    graphRequest.mockResolvedValue(snapshot([
      { ...seed(goal), type: 'goal' }, { ...seed(source), parentId: goal },
      { ...seed(child, 'todo', [source, external], [external]), parentId: goal },
      seed(external), seed(externalChild, 'todo', [external, single], [single]), seed(single),
    ]));
    mount(); await findTab('chains'); fireEvent.click(tab('goals'));
    const goalRow = document.querySelector<HTMLElement>(`[data-goal-id="${goal}"]`)!;
    const toggle = goalRow.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    fireEvent.click(toggle);
    act(() => browserNavigation().setView(projectHistory(TEST_VIEWER_ID, project, { section: 'tasks', view: 'goals', projectGraphWitness: source, detail: null }), { replace: true }));
    expect(await screen.findByTestId(`external-${external}`)).toBeVisible();
    fireEvent.click(screen.getByTestId(`external-${external}`));
    expect(await screen.findByTestId(`external-${single}`)).toBeVisible();
    fireEvent.click(screen.getByTestId(`external-${single}`));
    await waitFor(() => expect(document.querySelector('.task-detail-title')).toHaveTextContent(`任务 ${single}`));
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(document.querySelector<HTMLElement>('.task-detail-dialog')!).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(document.getElementById('project-goal-list')).toHaveFocus());
    expect(tab('goals')).toHaveAttribute('aria-selected', 'true');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('falls back to the visible chain list when a singleton origin disappears during refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const source = canonicalTask(1), child = canonicalTask(2), dependency = canonicalTask(3);
    const initial = [seed(source), seed(child, 'todo', [source, dependency], [dependency]), seed(dependency, 'done')];
    const refreshed = initial.map((task) => task.id === source || task.id === child ? { ...task, status: 'done' as const } : task);
    graphRequest.mockResolvedValueOnce(snapshot(initial)).mockResolvedValueOnce(snapshot(refreshed));
    mount(); await findChainRow(source);
    fireEvent.change(filters().getByRole('combobox', { name: '状态' }), { target: { value: 'todo' } });
    await openChain(source);
    const trigger = chainGraphButton(source);
    fireEvent.click(screen.getByTestId(`external-${dependency}`));
    await waitFor(() => expect(document.querySelector('.task-detail-title')).toHaveTextContent(`任务 ${dependency}`));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    expect(filters().getByRole('combobox', { name: '状态' })).toHaveValue('todo');
    fireEvent.click(within(document.querySelector<HTMLElement>('.task-detail-dialog')!).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(document.getElementById('project-chain-list')).toHaveFocus());
    expect(filters().getByRole('combobox', { name: '状态' })).toHaveValue('todo');
  });

  it('clamps a removed final page immediately and does not restore it when tasks return', async () => {
    const initial = snapshot(manyStandalone(41));
    const reduced = resetSnapshot(snapshot(manyStandalone(20)));
    graphRequest.mockResolvedValueOnce(initial).mockResolvedValueOnce(reduced).mockResolvedValueOnce(reduced).mockResolvedValueOnce(resetSnapshot({ ...initial }));
    mount(); await findTab('standalone'); fireEvent.click(tab('standalone'));
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    fireEvent.click(within(pagination('独立任务列表')).getByRole('button', { name: '下一页' }));
    expect(document.querySelectorAll('.standalone-row')).toHaveLength(1);
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(document.querySelectorAll('.standalone-row')).toHaveLength(20));
    expect(screen.queryByRole('navigation', { name: '独立任务列表分页' })).toBeNull();
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(pagination('独立任务列表')).toHaveTextContent('第 1 / 3 页'));
    expect(document.querySelectorAll('.standalone-row')).toHaveLength(20);
  });

  it('keeps every Goal child visible inside one top-level page entry', async () => {
    const root = canonicalTask(1);
    graphRequest.mockResolvedValue(snapshot([seed(root), ...Array.from({ length: 30 }, (_, position) => seed(canonicalTask(position + 2), 'todo', [root]))]));
    mount(); fireEvent.click(await findChainRow());
    expect(document.querySelectorAll('.goal-task-row')).toHaveLength(30);
    expect(screen.queryByRole('navigation', { name: '任务链列表分页' })).toBeNull();
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });
});

describe('status-first project presentation', () => {
  const recentCompletion = '2026-10-19T10:00:00Z';
  const oldCompletion = '2026-10-01T10:00:00Z';
  const completed = (value: number, when = recentCompletion, dependsOn: string[] = []) => ({ ...seed(canonicalTask(value), 'done', dependsOn), completedAt: when });
  const chain = (value: number, status: GraphTask['status'], when = recentCompletion): GraphTask[] => [
    status === 'done' ? completed(value, when) : seed(canonicalTask(value), status),
    status === 'done' ? completed(value + 1, when, [canonicalTask(value)]) : seed(canonicalTask(value + 1), 'todo', [canonicalTask(value)]),
  ];
  const presentedIds = (view: 'chains' | 'standalone') => [...document.querySelectorAll(view === 'chains' ? '.root-toggle' : '.standalone-row')]
    .map((item) => item.id.replace(view === 'chains' ? 'task-root-' : 'standalone-task-', ''));
  const overviewTitles = () => [...document.querySelectorAll('#project-overview-progress .overview-progress-title')]
    .map((item) => item.firstChild!.textContent);
  const title = (value: number) => `任务 ${canonicalTask(value)}`;
  const pagination = (view: 'chains' | 'standalone' | 'overview') => within(document.getElementById({
    chains: 'project-chain-list', standalone: 'project-standalone-list', overview: 'project-overview-progress',
  }[view])!).getByRole('navigation', {
    name: `${view === 'chains' ? '任务链列表' : view === 'standalone' ? '独立任务列表' : '整体进度'}分页`,
  });
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
  afterEach(() => {
    if (originalScrollIntoView === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  });

  it('orders both categories by complete status and retains exact timestamp and ID ties without changing the source graph', async () => {
    const at = (task: GraphTask, fraction: string): GraphTask => ({ ...task, createdAt: `2026-10-20T12:00:00.${fraction}Z` });
    const value = snapshot([
      at(completed(1), '123451'), at(seed(canonicalTask(2), 'todo', [canonicalTask(1)]), '123452'),
      at(seed(canonicalTask(101), 'in_progress'), '123453'),
      at(seed(canonicalTask(3), 'in_progress'), '123454'), at(seed(canonicalTask(4), 'todo', [canonicalTask(3)]), '123455'),
      at(seed(canonicalTask(102), 'in_progress'), '123456'),
      at(seed(canonicalTask(5)), '123457'), at(seed(canonicalTask(7)), '123457'),
      at(seed(canonicalTask(103)), '123457'), at(seed(canonicalTask(104)), '123457'),
      at(seed(canonicalTask(6), 'todo', [canonicalTask(5)]), '123458'), at(seed(canonicalTask(8), 'todo', [canonicalTask(7)]), '123458'),
      at(completed(9), '123459'), at(completed(10, recentCompletion, [canonicalTask(9)]), '123460'),
      at(completed(105), '123461'), at(completed(11), '123462'),
      at(completed(12, recentCompletion, [canonicalTask(11)]), '123463'), at(completed(106), '123464'),
    ]);
    const original = JSON.stringify(value.tasks);
    Object.freeze(value.tasks);
    for (const task of value.tasks) Object.freeze(task);
    expect(new Set(value.tasks.map((task) => Date.parse(task.createdAt))).size).toBe(1);
    graphRequest.mockResolvedValue(value);
    mount(); await findChainRow(canonicalTask(3));
    expect(presentedIds('chains')).toEqual([3, 1, 7, 5, 11, 9].map(canonicalTask));
    expect(chainRow(canonicalTask(1)).closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    fireEvent.click(tab('standalone'));
    expect(presentedIds('standalone')).toEqual([102, 101, 104, 103, 106, 105].map(canonicalTask));
    expect(JSON.stringify(value.tasks)).toBe(original);
    expectUnfinishedCounts(7, 4);
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it.each(['chains', 'standalone'] as const)('sorts the complete %s category before status filtering and pagination', async (view) => {
    const taskNumber = (position: number) => view === 'chains' ? position * 2 + 1 : position + 1_000;
    const tasks = Array.from({ length: 23 }, (_, position) => {
      const value = taskNumber(position);
      if (view === 'standalone') return [position === 0 ? seed(canonicalTask(value), 'in_progress')
        : position >= 21 ? completed(value, position === 22 ? oldCompletion : recentCompletion) : seed(canonicalTask(value))];
      if (position === 0) return [completed(value), seed(canonicalTask(value + 1), 'todo', [canonicalTask(value)])];
      return chain(value, position >= 21 ? 'done' : 'todo', position === 22 ? oldCompletion : recentCompletion);
    }).flat();
    graphRequest.mockResolvedValue(snapshot(tasks));
    mount(); await findTab('standalone');
    if (view === 'standalone') fireEvent.click(tab('standalone'));
    const unfinished = [0, ...Array.from({ length: 20 }, (_, position) => 20 - position)];
    const ids = (positions: number[]) => positions.map((position) => canonicalTask(taskNumber(position)));
    const firstPage = ids(unfinished.slice(0, 20));
    expect(presentedIds(view)).toEqual(firstPage);
    expect(pagination(view)).toHaveTextContent('第 1–20 条，共 23 条');
    fireEvent.click(within(pagination(view)).getByRole('button', { name: '下一页' }));
    expect(presentedIds(view)).toEqual(ids([...unfinished.slice(20), 22, 21]));
    fireEvent.change(filters().getByRole('combobox', { name: '状态' }), { target: { value: 'todo' } });
    if (view === 'chains') expect(pagination(view)).toHaveTextContent('第 1–20 条，共 21 条');
    else expect(screen.queryByRole('navigation', { name: '独立任务列表分页' })).toBeNull();
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it.each(['in_progress', 'todo', 'done'] as const)('places a %s standalone aggregate among the full overview sequence before pagination', async (status) => {
    const todoRoots = Array.from({ length: 19 }, (_, position) => position * 2 + 10);
    graphRequest.mockResolvedValue(snapshot([
      completed(1), seed(canonicalTask(2), 'todo', [canonicalTask(1)]),
      ...todoRoots.flatMap((value) => chain(value, 'todo')), ...chain(50, 'done'),
      status === 'done' ? completed(100) : seed(canonicalTask(100), status),
    ]));
    mount(); await findChainRow(canonicalTask(1));
    fireEvent.click(sectionTab('overview'));
    const expected = [title(1), ...todoRoots.toReversed().map(title), title(50)];
    expected.splice(status === 'in_progress' ? 1 : status === 'todo' ? 20 : 21, 0, '独立任务');
    expect(overviewTitles()).toEqual(expected.slice(0, 20));
    expect(pagination('overview')).toHaveTextContent('第 1–20 条，共 22 条');
    fireEvent.click(within(pagination('overview')).getByRole('button', { name: '下一页' }));
    expect(overviewTitles()).toEqual(expected.slice(20));
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it.each(['manual', 'polling'] as const)('reorders both task categories and overview together after a %s status refresh', async (refresh) => {
    if (refresh === 'polling') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    graphRequest.mockResolvedValueOnce(snapshot([
      completed(1), seed(canonicalTask(2), 'todo', [canonicalTask(1)]), ...chain(3, 'todo'), ...chain(5, 'done'),
      seed(canonicalTask(101), 'in_progress'), seed(canonicalTask(102)), completed(103),
    ])).mockResolvedValueOnce(snapshot([
      ...chain(1, 'done'), ...chain(3, 'in_progress'), ...chain(5, 'todo'),
      completed(101), seed(canonicalTask(102), 'in_progress'), seed(canonicalTask(103)),
    ]));
    mount(); await findChainRow(canonicalTask(1));
    expect(presentedIds('chains')).toEqual([1, 3, 5].map(canonicalTask));
    fireEvent.click(tab('standalone'));
    expect(presentedIds('standalone')).toEqual([101, 102, 103].map(canonicalTask));
    fireEvent.click(sectionTab('overview'));
    expect(overviewTitles()).toEqual([title(1), '独立任务', title(3), title(5)]);
    if (refresh === 'manual') fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    else await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(overviewTitles()).toEqual([title(3), '独立任务', title(5), title(1)]));
    selectTasks();
    expect(presentedIds('standalone')).toEqual([102, 103, 101].map(canonicalTask));
    fireEvent.click(tab('chains'));
    expect(presentedIds('chains')).toEqual([3, 5, 1].map(canonicalTask));
    expectUnfinishedCounts(4, 2);
    expect(graphRequest).toHaveBeenCalledTimes(2);
  });
});


it('filters cancelled membership without hiding readable cancelled tasks or counting them in completion progress', async () => {
  const rootTask = seed(canonicalTask(1), 'done');
  const cancelled = { ...seed(canonicalTask(2), 'cancelled', [rootTask.id]), cancelledAt: timestamp };
  const standalone = { ...seed(canonicalTask(3), 'cancelled'), cancelledAt: timestamp };
  graphRequest.mockResolvedValue(snapshot([rootTask, cancelled, standalone]));
  mount(); await findChainRow();
  fireEvent.change(filters().getByRole('combobox', { name: '状态' }), { target: { value: 'cancelled' } });
  expect(screen.getByRole('option', { name: '已取消' })).toBeInTheDocument();
  expect(chainRow().closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('1/1 已完成');
  fireEvent.click(tab('standalone')); await waitFor(() => expect(row(standalone.id)).toBeVisible());
  expect(row(rootTask.id)).toBeNull();
  await openStandalone(standalone.id);
  expect(screen.getByRole('button', { name: '已取消' })).toBeDisabled();
});
