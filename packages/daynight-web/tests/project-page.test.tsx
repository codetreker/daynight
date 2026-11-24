import { selectStatus, statusLabel, statusTrigger } from './helpers/statusFilter';
import { browserNavigation } from "../src/app/navigation";
import { taskSyncReadFixture, createGraphSyncFixture } from "./helpers/taskSync";
import { useEffect } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getTask, getTaskSync } from "../src/api/client";
import { getProject } from "../src/api/project-settings";
import { getProjectAccess } from "../src/api/auth";
import { directAccessFixture, TEST_VIEWER_ID } from "./helpers/taskSync";
import { searchTasks, TaskSearchError } from "../src/api/task-search";
import { listProjectTags, resolveProjectTagColors, resolveProjectTags } from "../src/api/task-tags";
import type { GraphTask, TaskDetail, TaskGraph, TaskStatus } from "../src/api/types";
import { ProjectPage } from "../src/features/projects/ProjectPage";
import type { GraphSnapshot } from "../src/features/projects/useTaskGraph";
import { useTaskDetail } from "../src/features/task-detail/useTaskDetail";
import { projectChain, type GraphIndex } from "../src/features/task-graph/model";
import * as TaskSearchModule from "../src/features/task-search/useTaskSearch";
import { waitForState } from "./helpers/waitForState";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { ListPagination } from "../src/features/projects/ListPagination";
import type { PaginationState } from "../src/features/projects/usePagination";

const localeRender = createLocaleRender("zh-CN");
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock("../src/api/client", async (original) => { const actual = await original<typeof import("../src/api/client")>(); const { fixtureTaskEpoch } = await import("./helpers/taskSync"); const read = vi.fn(); return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), getTaskSync: vi.fn() }; });
vi.mock("../src/api/task-tags", async (original) => ({ ...await original<typeof import("../src/api/task-tags")>(), listProjectTags: vi.fn(), resolveProjectTags: vi.fn(), resolveProjectTagColors: vi.fn() }));
vi.mock("../src/api/task-search", async (original) => ({ ...await original<typeof import("../src/api/task-search")>(), searchTasks: vi.fn() }));
vi.mock("../src/api/project-settings", async (original) => ({ ...await original<typeof import("../src/api/project-settings")>(), getProject: vi.fn() }));
vi.mock("../src/api/auth", async (original) => ({ ...await original<typeof import("../src/api/auth")>(), getProjectAccess: vi.fn() }));
vi.mock("../src/features/task-graph/ChainList", () => ({ ChainList: ({ index, representativeIds, openGraphTarget, onOpenChain, onOpenChainUsage, onCloseChain, onOpenTask, onOpenSession, pagination }: {
  index: GraphIndex; representativeIds: readonly string[]; openGraphTarget: { kind: 'chain'; witnessTaskId: string; rootId: string } | null; onOpenChain: (id: string, trigger: HTMLElement) => void; onOpenChainUsage: (id: string, trigger: HTMLElement) => void; onCloseChain: () => void; onOpenTask: (id: string, trigger: HTMLElement) => void; onOpenSession?: (id: string, trigger: HTMLElement) => void; pagination?: PaginationState;
}) => <div data-testid="root-list" data-index-roots={index.representativeIds.join(",")}>{representativeIds.map((root) => <div key={root}>
  <button onClick={(event) => onOpenSession?.(root, event.currentTarget)}>进入会话 {root}</button>
  <button id={`task-root-${root}`} aria-haspopup="dialog" onClick={(event) => onOpenChain(root, event.currentTarget)}>{index.nodes.get(root)!.titlePreview}</button>
  <button onClick={event => onOpenChainUsage(root, event.currentTarget)}>用量 {root}</button>
  {openGraphTarget?.kind === 'chain' && openGraphTarget.rootId === root && <div role="dialog" className="task-chain-dialog" id={`task-graph-${root}`} data-testid={`chain-${root}`}>
    <button className="task-chain-close" onClick={onCloseChain}>关闭依赖图</button>
    {[...projectChain(index, root).mainIds].map((id) => <button key={id} onClick={(event) => onOpenTask(id, event.currentTarget)}>节点 {index.nodes.get(id)!.titlePreview}</button>)}
  </div>}
</div>)}{pagination !== undefined && <ListPagination label="任务链列表" {...pagination} />}</div> }));
const usagePanelLifecycle = vi.hoisted(() => ({ mounted: vi.fn(), cancelled: vi.fn() }));
vi.mock("../src/features/usage-aggregate/UsageAggregatePanel", () => ({
  UsageAggregatePanel: ({ scopeId, onOpenTask }: { scopeId: string; onOpenTask: (id: string, trigger: HTMLElement) => void }) => {
    useEffect(() => { usagePanelLifecycle.mounted(scopeId); return () => { usagePanelLifecycle.cancelled(scopeId); }; }, [scopeId]);
    return <div data-testid="usage-panel">{scopeId}<button onClick={event => onOpenTask(B, event.currentTarget)}>打开未完整成员</button></div>;
  },
  UsageAggregateDisclosure: () => null,
}));
vi.mock("../src/features/task-graph/GoalGraphDialog", () => ({ GoalGraphDialog: ({ goalId, onClose, onOpenTask, onRootChange }: { goalId: string; onClose: () => void; onOpenTask: (id: string, trigger: HTMLElement) => void; onRootChange?: (element: HTMLElement | null) => void }) =>
  <div ref={onRootChange} className="task-chain-dialog" role="dialog" data-testid={`goal-graph-${goalId}`}><button onClick={onClose}>关闭整体图</button><button onClick={event => onOpenTask(goalId, event.currentTarget)}>打开整体图详情</button></div> }));
vi.mock("../src/features/task-detail/TaskDetailDialog", () => ({ TaskDetailDialog: ({ projectId, taskId, snapshot, observation, navigation, onSelectTask, onClose, onRestoreFocus, onRefreshGraph }: {
  projectId: string; taskId: string; snapshot: GraphSnapshot | null; observation: { kind: string }; navigation: { tab: string }; onSelectTask: (id: string) => void; onClose: () => void; onRestoreFocus: () => void; onRefreshGraph: () => void;
}) => {
  const state = useTaskDetail(projectId, taskId, snapshot?.revision ?? 0, snapshot?.index.nodes.get(taskId));
  useEffect(() => () => onRestoreFocus(), [onRestoreFocus]);
  return <aside aria-label="详情测试外壳"><p data-testid="selected-task">{taskId}</p><p data-testid="detail-tab">{navigation.tab}</p><p data-testid="observation-kind">{observation.kind}</p><p data-testid="detail-state">{state.status}</p><p data-testid="detail-title">{state.detail?.title}</p><p data-testid="detail-business-status">{state.detail?.status}</p>
    <button onClick={() => onSelectTask(C)}>关系跳转</button><button onClick={() => onSelectTask(X)}>未知关系</button>
    <button onClick={onRefreshGraph}>刷新全图</button><button onClick={onClose}>关闭详情</button></aside>;
} }));

const projectId = "10000000-0000-0000-0000-000000000001";
const otherProject = "10000000-0000-0000-0000-000000000002";
const A = "20000000-0000-0000-0000-000000000001";
const B = "20000000-0000-0000-0000-000000000002";
const C = "20000000-0000-0000-0000-000000000003";
const D = "20000000-0000-0000-0000-000000000004";
const E = "20000000-0000-0000-0000-000000000005";
const F = "20000000-0000-0000-0000-000000000006";
const X = "20000000-0000-0000-0000-000000000009";
const Y = "20000000-0000-0000-0000-000000000008";
const time = "2026-10-20T12:00:00.123456Z";
type Seed = { id: string; externalDependsOn?: readonly string[]; title: string; status: TaskStatus; dependsOn: readonly string[] };
const seeds: readonly Seed[] = [
  { id: A, title: "已完成根", status: "done", dependsOn: [] }, { id: B, title: "后续任务", status: "todo", dependsOn: [A] },
  { id: C, title: "另一任务链", status: "todo", dependsOn: [] }, { id: D, title: "阻塞任务", status: "todo", dependsOn: [C] },
];
const graph = (items = seeds, id = projectId): TaskGraph => {
  const tasks: GraphTask[] = items.map((seed) => {
    const blockedBy = seed.dependsOn.filter((id) => items.find((item) => item.id === id)?.status !== "done");
    return { type: 'task', parentId: null, parentTaskId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: seed.externalDependsOn ?? [], startedAt: null, completedAt: null, cancelledAt: null, id: seed.id, titlePreview: seed.title, titleTruncated: false, status: seed.status, dependsOn: seed.dependsOn, blockedBy,
      ready: seed.status === "todo" && blockedBy.length === 0, createdAt: time, updatedAt: time };
  });
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id, name: id === projectId ? "核心项目" : "另一个项目", repoUrl: "git@github.com:example/project.git", createdAt: time, updatedAt: time }, tasks,
    summary: { proposed: 0, total: tasks.length, todo: tasks.filter((task) => task.status === "todo").length,
      done: tasks.filter((task) => task.status === "done").length, cancelled: 0, inProgress: tasks.filter((task) => task.status === "in_progress").length,
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.status === "todo" && !task.ready).length },
  };
};
const goalGraph = (id = A): TaskGraph => {
  const value = graph([{ id, title: '链接 Goal', status: 'todo', dependsOn: [] }]);
  return { ...value, tasks: value.tasks.map(task => ({ ...task, type: 'goal' as const })) };
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const detailRequest = vi.mocked(getTask);
const waitForGraph = () => waitFor(() => expect(document.querySelector(".snapshot-time time")).not.toBeNull());
const sectionTabs = () => within(document.querySelector<HTMLElement>(".project-section-tabs")!);
const taskTabs = () => within(document.querySelector<HTMLElement>(".project-task-tabs")!);
const titleActions = () => within(document.querySelector<HTMLElement>(".project-title-actions")!);
const chainList = () => within(screen.getByTestId("root-list"));
const chainDialog = () => within(document.querySelector<HTMLElement>('[id^="task-graph-"]')!);
const detail = () => within(screen.getByLabelText("详情测试外壳"));
const searchForm = () => within(document.querySelector<HTMLElement>(".task-search-form")!);
const searchResults = () => within(document.querySelector<HTMLElement>(".task-search-results")!);
const listButton = (name: string) => chainList().getByRole("button", { name });
const findListButton = (name: string) => waitFor(() => listButton(name));
const findNodeButton = (name: string) => waitFor(() => chainDialog().getByRole("button", { name }));
const selectTasks = () => { fireEvent.click(sectionTabs().getByRole('tab', { name: '任务列表' })); };
const number = (label: string) => screen.getByText(label, { selector: ".stat-label" }).parentElement?.querySelector(".stat-number")?.textContent;
const preferenceKey = (id = projectId) => `daynight:project-view:${id}`;
const rememberRoot = (root: string | null, id = projectId) => window.localStorage.setItem(preferenceKey(id), JSON.stringify({ expandedRootId: root }));
const openChain = async (name: string) => { fireEvent.click(await findListButton(name)); };

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture({ propertiesForTask: () => ({ pullRequests: [] }) });
const servedGraphs = new Map<string, TaskGraph>();
const servedVersions = new Map<string, bigint>();
beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${projectId}`);
  vi.mocked(getProject).mockReset().mockImplementation(async (id) => graph(seeds, id).project);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (id, _signal, admission) => directAccessFixture(id, admission.userId));
  vi.mocked(searchTasks).mockReset();
  vi.mocked(listProjectTags).mockReset().mockResolvedValue({ items: [], catalogEpoch: "00000000-0000-4000-8000-000000000001", nextCursor: null });
  vi.mocked(resolveProjectTagColors).mockReset().mockImplementation(async (_project, ids, epoch) => ({ catalogEpoch: epoch ?? A, items: ids.map(id => ({ id, state: "found", version: 1n, color: "#9AA3B2" })) }));
  syncFixture.reset();
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
  graphRequest.mockReset().mockImplementation(async (id) => servedGraphs.get(id)!); detailRequest.mockReset();
  detailRequest.mockImplementation(async (project, id): Promise<TaskDetail> => {
    const task = servedGraphs.get(project)!.tasks.find((item) => item.id === id);
    if (id === X) return { tags: [], type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null,
      id, projectId: project, title: 'New task', description: '文本', properties: { pullRequests: [] }, status: 'todo', version: 1n, dependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time };
    return { ...task!, tags: [], id, projectId: project, title: task!.titlePreview, description: '文本', properties: { pullRequests: [] }, version: servedVersions.get(`${project}/${id}`)! };
  });
});

describe("project dashboard", () => {
  it('uses only eligible members for chain filtering and locates a mixed chain from the overview', async () => {
    const source = graph([
      { id: A, title: '普通子任务根', status: 'done', dependsOn: [] },
      { id: B, title: '可见任务', status: 'todo', dependsOn: [A] },
      { id: C, title: '纯子任务根', status: 'done', dependsOn: [] },
      { id: D, title: '纯子任务后续', status: 'todo', dependsOn: [C] },
      { id: E, title: '独立任务', status: 'todo', dependsOn: [] },
    ]);
    graphRequest.mockResolvedValue({ ...source, tasks: source.tasks.map(item => [A, C, D].includes(item.id) ? { ...item, parentTaskId: F } : item) });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<ProjectPage projectId={projectId} />); selectTasks();
      await findListButton('普通子任务根');
      expect(chainList().queryByRole('button', { name: '纯子任务根' })).toBeNull();
      selectStatus('done');
      expect(chainList().queryByRole('button', { name: '普通子任务根' })).toBeNull();
      fireEvent.click(sectionTabs().getByRole('tab', { name: '概览' }));
      fireEvent.click(within(document.getElementById('project-overview-progress')!).getByRole('button', { name: /普通子任务根.*前往任务列表/ }));
      await waitFor(() => expect(listButton('普通子任务根')).toHaveFocus());
      expect(statusTrigger()).toHaveTextContent(statusLabel('all'));
    } finally { HTMLElement.prototype.scrollIntoView = scroll; }
  });
  it('restarts chain usage only after the new history snapshot and keeps the selected member when the anchor disappears', async () => {
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const subscribe = scope.subscribe.bind(scope);
    const listeners = new Set<Parameters<typeof scope.subscribe>[0]>();
    vi.spyOn(scope, 'subscribe').mockImplementation(listener => { listeners.add(listener); const stop = subscribe(listener); return () => { listeners.delete(listener); stop(); }; });
    usagePanelLifecycle.mounted.mockClear(); usagePanelLifecycle.cancelled.mockClear();
    const initial = graph(); graphRequest.mockResolvedValue(initial);
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root);
    try {
      const view = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope }, container: root, baseElement: document.body });
      await waitForGraph(); selectTasks();
      fireEvent.click(await screen.findByRole('button', { name: `用量 ${A}` }));
      expect(await screen.findByTestId('usage-panel')).toHaveTextContent(A);
      fireEvent.click(screen.getByRole('button', { name: '打开未完整成员' }));
      expect(await screen.findByTestId('selected-task')).toHaveTextContent(B);
      const next = deferred<TaskGraph>(); graphRequest.mockReturnValue(next.promise);
      const requestCount = graphRequest.mock.calls.length;
      act(() => { for (const listener of listeners) listener({ projectId, historyChanged: true }); });
      expect(screen.queryByTestId('usage-panel')).toBeNull();
      expect(screen.getByText('正在确认任务链…')).toBeVisible();
      expect(usagePanelLifecycle.cancelled).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('selected-task')).toHaveTextContent(B);
      expect(usagePanelLifecycle.mounted).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(graphRequest.mock.calls.length).toBeGreaterThan(requestCount));
      await act(async () => next.reject(new ApiError('network')));
      expect(await screen.findByText('无法确认任务链，请重试。')).toBeVisible();
      expect(screen.queryByTestId('usage-panel')).toBeNull();
      const retried = deferred<TaskGraph>(); graphRequest.mockReturnValue(retried.promise);
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重试' }));
      await act(async () => retried.resolve(graph()));
      await waitFor(() => expect(usagePanelLifecycle.mounted).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('usage-panel')).toHaveTextContent(A);
      expect(screen.getByTestId('selected-task')).toHaveTextContent(B);
      const withoutAnchor = graph([{ id: B, title: '后续任务', status: 'todo', dependsOn: [] }, ...seeds.slice(2)]);
      graphRequest.mockResolvedValue(resetSnapshot(withoutAnchor));
      fireEvent.click(detail().getByRole('button', { name: '刷新全图' }));
      expect(await screen.findByText('此用量范围已不可用。')).toBeVisible();
      expect(screen.getByTestId('selected-task')).toHaveTextContent(B);
      expect(usagePanelLifecycle.mounted).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally { scope.dispose(); root.remove(); }
  });

  it('opens a linked empty Goal only after the authoritative snapshot, keeps its URL, and removes it on close', async () => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}#chain=${B}`);
    const pending = deferred<TaskGraph>(); graphRequest.mockReturnValue(pending.promise);
    const length = history.length;
    render(<ProjectPage projectId={projectId} />);
    expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
    expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
    await act(async () => pending.resolve(goalGraph()));
    expect(await screen.findByTestId(`goal-graph-${A}`)).toBeVisible();
    expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
    expect(location.hash).toBe(''); expect(history.length).toBe(length);
    expect(localStorage.getItem(`daynight:project-section:${projectId}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭整体图' }));
    expect(location.search).toBe('?tab=tasks');
    expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
  });

  it.each([`goalGraph=${A}`, `tab=tasks&goalGraph=bad`, `tab=tasks&goalGraph=${A}&chain=${B}`])('rejects the original malformed Goal address %s without waiting for data', async query => {
    history.replaceState(null, '', `/projects/${projectId}?${query}#chain=${B}`);
    graphRequest.mockReturnValue(deferred<TaskGraph>().promise);
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByText('对应的任务分组已不可见，请从任务列表选择任务。')).toBeVisible();
    expect(new URLSearchParams(location.search).has('goalGraph')).toBe(false);
    expect(new URLSearchParams(location.search).has('chain')).toBe(false);
    expect(location.hash).toBe('');
  });

  it.each([A, X])('rejects a Task or absent Goal ID %s only after the complete snapshot', async id => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${id}`);
    const pending = deferred<TaskGraph>(); graphRequest.mockReturnValue(pending.promise);
    render(<ProjectPage projectId={projectId} />);
    expect(location.search).toContain(`goalGraph=${id}`);
    await act(async () => pending.resolve(graph()));
    expect(await screen.findByText('对应的任务分组已不可见，请从任务列表选择任务。')).toBeVisible();
    expect(location.search).toBe('?tab=tasks');
    expect(screen.queryByTestId(`goal-graph-${id}`)).toBeNull();
  });

  it('keeps a valid Goal address on an initial failure and opens it after retry', async () => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
    graphRequest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(goalGraph());
    render(<ProjectPage projectId={projectId} />);
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
    expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
    fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
    expect(await screen.findByTestId(`goal-graph-${A}`)).toBeVisible();
    expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
  });

  it('opens a Goal hidden by pagination without moving the list page', async () => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
    const items = [A, ...Array.from({ length: 22 }, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)];
    const value = graph(items.map(id => ({ id, title: `Goal ${id}`, status: 'todo' as const, dependsOn: [] })));
    graphRequest.mockResolvedValue({ ...value, tasks: value.tasks.map(task => ({ ...task, type: 'goal' as const, createdAt: task.id === A ? '2026-10-19T12:00:00Z' : time })) });
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`goal-graph-${A}`)).toBeVisible();
    expect(document.getElementById(`project-goal-graph-${A}`)).toBeNull();
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();
    expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
  });

  it('does not admit a cached Goal until the new authoritative project snapshot confirms it', async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(goalGraph()).mockReturnValueOnce(pending.promise);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const first = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
    try {
      await waitForGraph();
      first.unmount();
      browserNavigation().dispose();
      history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
      const second = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
      try {
        await waitForState(() => expect(graphRequest).toHaveBeenCalledTimes(2));
        expect(await screen.findByText('链接 Goal')).toBeVisible();
        expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
        expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
        await act(async () => pending.resolve(resetSnapshot(graph([]))));
        expect(await screen.findByText('对应的任务分组已不可见，请从任务列表选择任务。')).toBeVisible();
        expect(location.search).toBe('?tab=tasks');
        expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
      } finally { second.unmount(); }
    } finally { first.unmount(); scope.dispose(); }
  });

  it('admits only the latest Goal URL when a cached background precedes a delayed snapshot', async () => {
    const items = [A, B].map(id => ({ id, title: `Cached Goal ${id}`, status: 'todo' as const, dependsOn: [] }));
    const original = graph(items);
    const goals = { ...original, tasks: original.tasks.map(task => ({ ...task, type: 'goal' as const })) };
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(goals).mockReturnValueOnce(pending.promise);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const first = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
    try {
      await waitForGraph();
      first.unmount();
      browserNavigation().dispose();
      history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
      const second = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
      try {
        await waitForState(() => expect(graphRequest).toHaveBeenCalledTimes(2));
        expect(await screen.findByText(`Cached Goal ${A}`)).toBeVisible();
        expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
        act(() => browserNavigation().navigate(`/projects/${projectId}?tab=tasks&goalGraph=${B}`));
        expect(location.search).toBe(`?tab=tasks&goalGraph=${B}`);
        await act(async () => pending.resolve(goals));
        expect(await screen.findByTestId(`goal-graph-${B}`)).toBeVisible();
        expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
        expect(location.search).toBe(`?tab=tasks&goalGraph=${B}`);
      } finally { second.unmount(); }
    } finally { first.unmount(); scope.dispose(); }
  });

  it('does not use a Goal cached in another project to admit the current project URL', async () => {
    history.replaceState(null, '', `/projects/${otherProject}`);
    const foreign = goalGraph();
    graphRequest.mockResolvedValueOnce({ ...foreign, project: graph([], otherProject).project }).mockResolvedValueOnce(graph([]));
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const first = localeRender(<ProjectPage projectId={otherProject} />, { taskCache: { scope } });
    try {
      await waitForGraph();
      first.unmount();
      browserNavigation().dispose();
      history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
      const second = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
      try {
        expect(await screen.findByText('对应的任务分组已不可见，请从任务列表选择任务。')).toBeVisible();
        expect(location.search).toBe('?tab=tasks');
        expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
      } finally { second.unmount(); }
    } finally { first.unmount(); scope.dispose(); }
  });

  it('does not open a pending linked Goal after leaving the project task section', async () => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
    const pending = deferred<TaskGraph>(); graphRequest.mockReturnValue(pending.promise);
    render(<ProjectPage projectId={projectId} />);
    fireEvent.click(sectionTabs().getByRole('tab', { name: '标签' }));
    expect(location.search).toBe('?tab=tags');
    await act(async () => pending.resolve(goalGraph()));
    await waitForGraph();
    expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
  });

  it('retires a nested draft and removes the link when a confirmed refresh deletes its Goal', async () => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
    graphRequest.mockResolvedValue(goalGraph());
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
    try {
      expect(await screen.findByTestId(`goal-graph-${A}`)).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: '打开整体图详情' }));
      expect(await screen.findByTestId('selected-task')).toHaveTextContent(A);
      const discard = vi.fn();
      const release = browserNavigation().register({ scope: { identity: scope, projectId, taskId: A }, isDirty: () => true, discard, survives: () => false });
      graphRequest.mockResolvedValue(resetSnapshot(graph([])));
      fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(location.search).toBe('?tab=tasks'));
      expect(discard).toHaveBeenCalledOnce();
      expect(screen.queryByTestId(`goal-graph-${A}`)).toBeNull();
      expect(screen.queryByTestId('selected-task')).toBeNull();
      expect(browserNavigation().decision()).toBeNull();
      release();
    } finally { view.unmount(); scope.dispose(); }
  });

  it('keeps linked Goal details and drafts on a normal refresh in the same history', async () => {
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks&goalGraph=${A}`);
    graphRequest.mockResolvedValue(goalGraph());
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
    try {
      expect(await screen.findByTestId(`goal-graph-${A}`)).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: '打开整体图详情' }));
      expect(await screen.findByTestId('selected-task')).toHaveTextContent(A);
      const discard = vi.fn();
      const release = browserNavigation().register({ scope: { identity: scope, projectId, taskId: A }, isDirty: () => true, discard, survives: () => false });
      fireEvent.click(titleActions().getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(titleActions().getByRole('button', { name: '刷新' })).toBeEnabled());
      expect(discard).not.toHaveBeenCalled();
      expect(screen.getByTestId(`goal-graph-${A}`)).toBeVisible();
      expect(screen.getByTestId('selected-task')).toHaveTextContent(A);
      expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
      release();
    } finally { view.unmount(); scope.dispose(); }
  });

  it.each(['indexed', 'native'] as const)('does not rewrite a different %s entry with the same Goal URL during revocation', async kind => {
    const url = `/projects/${projectId}?tab=tasks&goalGraph=${A}`;
    history.replaceState(null, '', url);
    graphRequest.mockResolvedValue(goalGraph());
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
    try {
      expect(await screen.findByTestId(`goal-graph-${A}`)).toBeVisible();
      const target = kind === 'indexed' ? history.state : { nativeMarker: 'target' };
      fireEvent.click(screen.getByRole('button', { name: '打开整体图详情' }));
      expect(await screen.findByTestId('selected-task')).toHaveTextContent(A);
      const discard = vi.fn();
      const release = browserNavigation().register({ scope: { identity: scope, projectId, taskId: A }, isDirty: () => true, discard, survives: () => false });
      act(() => {
        history.replaceState(target, '', url);
        dispatchEvent(new PopStateEvent('popstate', { state: target }));
        if (kind === 'indexed') expect(browserNavigation().decision()).not.toBeNull();
        scope.suspendProject(projectId);
      });
      expect(discard).toHaveBeenCalledOnce();
      expect(location.search).toBe(`?tab=tasks&goalGraph=${A}`);
      if (kind === 'indexed') expect(history.state.__daynightNavigation.entryId).toBe(target.__daynightNavigation.entryId);
      else expect(history.state).toEqual({ nativeMarker: 'target' });
      release();
    } finally { view.unmount(); scope.dispose(); }
  });
  it.each([["overview", "概览"], ["tasks", "任务列表"], ["prs", "PR 列表"], ["tags", "标签"]] as const)(
    "opens %s directly despite a conflicting preference and does not save it", async (tab, label) => {
      history.replaceState(null, "", `/projects/${projectId}?tab=${tab}`);
      localStorage.setItem(`daynight:project-section:${projectId}`, JSON.stringify(tab === "tags" ? "overview" : "tags"));
      graphRequest.mockResolvedValue(graph());
      render(<ProjectPage projectId={projectId} />);
      expect(sectionTabs().getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      expect(sectionTabs().getByRole("tab", { name: label })).toHaveAttribute("href", `/projects/${projectId}?tab=${tab}`);
      expect(localStorage.getItem(`daynight:project-section:${projectId}`)).toBe(JSON.stringify(tab === "tags" ? "overview" : "tags"));
      expect(location.search).toBe(`?tab=${tab}`);
      await waitForGraph();
    },
  );

  it("normalizes a bare entry from preference without adding an entry or replacing the project panels", async () => {
    localStorage.setItem(`daynight:project-section:${projectId}`, JSON.stringify("tasks"));
    graphRequest.mockResolvedValue(graph());
    const length = history.length;
    render(<ProjectPage projectId={projectId} />);
    expect(sectionTabs().getByRole("tab", { name: "任务列表" })).toHaveAttribute("aria-selected", "true");
    expect(location.search).toBe("?tab=tasks"); expect(history.length).toBe(length);
    await findListButton("已完成根");
    const panel = document.getElementById("project-section-panel-tasks");
    fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
    expect(location.search).toBe("?tab=overview");
    fireEvent.click(sectionTabs().getByRole("tab", { name: "任务列表" }));
    expect(location.search).toBe("?tab=tasks");
    expect(document.getElementById("project-section-panel-tasks")).toBe(panel);
  });

  it("consumes a pending multi-member chain fragment by replacing the URL and selecting tasks", async () => {
    history.replaceState(null, "", `/projects/${projectId}?other=retained&tab=prs#chain=${A}`);
    graphRequest.mockResolvedValue(graph());
    const length = history.length;
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(location.search).toBe("?other=retained&tab=tasks");
    expect(location.hash).toBe(""); expect(history.length).toBe(length);
    expect(sectionTabs().getByRole("tab", { name: "任务列表" })).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem(`daynight:project-section:${projectId}`)).toBeNull();
  });

  it("consumes a chain query through the current component and does not replay a competing fragment", async () => {
    history.replaceState(null, "", `/projects/${projectId}?other=retained&tab=tasks&chain=${B}#chain=${C}`);
    graphRequest.mockResolvedValue(graph());
    const length = history.length;
    const view = render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    expect(location.search).toBe("?other=retained&tab=tasks");
    expect(location.hash).toBe(""); expect(history.length).toBe(length);
    fireEvent.click(chainDialog().getByRole('button', { name: '关闭依赖图' }));
    view.rerender(<ProjectPage projectId={projectId} />);
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it.each([`chain=${X}`, 'chain=bad', `chain=${A}&chain=${B}`])("consumes an unavailable or invalid chain query %s", async query => {
    history.replaceState(null, "", `/projects/${projectId}?tab=tasks&other=retained&${query}`);
    graphRequest.mockResolvedValue(graph());
    const length = history.length;
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByText("对应的任务分组已不可见，请从任务列表选择任务。")).toBeVisible();
    expect(location.search).toBe('?tab=tasks&other=retained'); expect(history.length).toBe(length);
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it("discards a chain query when the user changes section while the index is pending", async () => {
    history.replaceState(null, "", `/projects/${projectId}?tab=tasks&chain=${A}`);
    const pending = deferred<TaskGraph>(); graphRequest.mockReturnValue(pending.promise);
    render(<ProjectPage projectId={projectId} />);
    fireEvent.click(sectionTabs().getByRole("tab", { name: "标签" }));
    expect(location.search).toBe('?tab=tags');
    await act(async () => { pending.resolve(graph()); });
    await waitForGraph();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it("opens the task when the query witness has become a singleton", async () => {
    history.replaceState(null, "", `/projects/${projectId}?tab=tasks&chain=${A}`);
    graphRequest.mockResolvedValue(graph([seeds[0]!]));
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId('selected-task')).toHaveTextContent(A);
    expect(location.search).toBe('?tab=tasks');
  });

  it("consumes an invalid fragment without changing the selected section", async () => {
    history.replaceState(null, "", `/projects/${projectId}?tab=prs#task=${X}`);
    graphRequest.mockResolvedValue(graph());
    const length = history.length;
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByText("对应的任务分组已不可见，请从任务列表选择任务。")).toBeVisible();
    expect(location.search).toBe("?tab=prs"); expect(location.hash).toBe(""); expect(history.length).toBe(length);
    expect(sectionTabs().getByRole("tab", { name: "PR 列表" })).toHaveAttribute("aria-selected", "true");
  });

  it("discards a pending fragment when the user changes section before the index is ready", async () => {
    history.replaceState(null, "", `/projects/${projectId}?tab=prs#chain=${A}`);
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValue(pending.promise);
    render(<ProjectPage projectId={projectId} />);
    fireEvent.click(sectionTabs().getByRole("tab", { name: "标签" }));
    expect(location.search).toBe("?tab=tags"); expect(location.hash).toBe("");
    await act(async () => { pending.resolve(graph()); });
    await waitFor(() => expect(sectionTabs().getByRole("tab", { name: "标签" })).toHaveAttribute("aria-selected", "true"));
    expect(location.search).toBe("?tab=tags"); expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it("does not repeat a cancelled fragment decision on the same location after rerender", async () => {
    history.replaceState(null, "", `/projects/${projectId}?tab=prs`);
    graphRequest.mockResolvedValue(graph());
    const view = render(<ProjectPage projectId={projectId} />);
    await waitForGraph();
    const navigation = browserNavigation(), discard = vi.fn();
    const release = navigation.register({ scope: { identity: {}, projectId, taskId: A }, isDirty: () => true, discard, survives: () => false });
    act(() => { history.pushState({ foreign: true }, '', `/projects/${projectId}?tab=prs#chain=${A}`); dispatchEvent(new PopStateEvent('popstate')); });
    await waitFor(() => expect(navigation.decision()).not.toBeNull());
    act(() => navigation.cancel());
    view.rerender(<ProjectPage projectId={projectId} />);
    expect(navigation.decision()).toBeNull();
    expect(location.search).toBe('?tab=prs'); expect(location.hash).toBe(`#chain=${A}`);
    expect(discard).not.toHaveBeenCalled();
    release();
  });

  it("waits for another pending navigation decision before consuming the fragment", async () => {
    history.replaceState(null, "", `/projects/${projectId}?tab=prs#chain=${A}`);
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValue(pending.promise);
    render(<ProjectPage projectId={projectId} />);
    const navigation = browserNavigation(), discard = vi.fn(), unrelated = vi.fn();
    const release = navigation.register({ scope: { identity: {}, projectId, taskId: A }, isDirty: () => true, discard, survives: () => false });
    act(() => navigation.requestAction(unrelated));
    const decision = navigation.decision();
    await act(async () => { pending.resolve(graph()); });
    expect(navigation.decision()).toBe(decision); expect(location.hash).toBe(`#chain=${A}`);
    act(() => navigation.cancel());
    await waitFor(() => expect(navigation.decision()).not.toBeNull());
    expect(navigation.decision()).not.toBe(decision);
    expect(unrelated).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
    act(() => navigation.cancel()); release();
  });

  it("keeps the current page when a background snapshot changes the page count", async () => {
    const makeSeeds = (count: number): Seed[] => Array.from({ length: count }, (_, i) => ({ id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title: `Task ${i + 1}`, status: "todo", dependsOn: [] }));
    graphRequest.mockResolvedValueOnce(graph(makeSeeds(21))).mockResolvedValue(graph(makeSeeds(41)));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("tab", { name: /独立任务/ });
    fireEvent.click(taskTabs().getByRole("tab", { name: /独立任务/ }));
    document.getElementById("project-standalone-list")!.scrollIntoView = vi.fn();
    const pagination = () => within(document.querySelector<HTMLElement>("#project-standalone-list .list-pagination")!);
    await waitFor(() => expect(pagination().getByRole("button", { name: "下一页" })).toBeEnabled());
    fireEvent.click(pagination().getByRole("button", { name: "下一页" }));
    expect(pagination().getByText(/2 \/ 2/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(pagination().getByText(/2 \/ 3/)).toBeVisible());
  });

  it("shares tags between local chains and search without changing graph context", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    vi.mocked(resolveProjectTags).mockResolvedValue([{ id: E, name: "后端" }]);
    graphRequest.mockResolvedValue(graph());
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === B ? [{ id: E, name: "后端" }] : [] })) });
    });
    vi.mocked(searchTasks).mockResolvedValue({ projectId, total: 0, items: [], nextCursor: null });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("另一任务链");
    const chainCount = () => document.querySelector("#project-task-tab-chains .graph-count-pill");
    expect(chainCount()).toHaveTextContent(/^2$/);
    const filter = screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!;
    expect(filter.parentElement?.parentElement?.previousElementSibling).toHaveClass("task-status-filter");
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
    expect(chainList().getByRole("button", { name: "已完成根" })).toBeVisible();
    expect(chainList().queryByRole("button", { name: "另一任务链" })).toBeNull();
    expect(chainCount()).toHaveTextContent(/^2$/);
    expect(screen.getByTestId("root-list")).toHaveAttribute("data-index-roots", expect.stringContaining(C));
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "query" } }); fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(searchTasks).toHaveBeenCalledWith(projectId, "query", expect.objectContaining({ type: "task", tagIds: [E], tagMatch: "all" }), null, expect.anything(), expect.anything(), expect.anything()));
    expect(chainCount()).toHaveTextContent(/^2$/);
    const searchFilter = document.querySelector(".task-search-filters .tag-filter > summary")!;
    expect(searchFilter).toHaveTextContent("标签筛选");
    expect(searchFilter.querySelector(".select-trigger__count")).toHaveTextContent("1");
    expect(searchFilter.parentElement?.parentElement?.previousElementSibling).toHaveClass("task-status-filter");
    expect(document.querySelectorAll(".tag-filter")).toHaveLength(1);
    fireEvent.click(searchForm().getByRole("button", { name: "清空搜索" }));
    expect(chainCount()).toHaveTextContent(/^2$/);
    expect(chainList().queryByRole("button", { name: "另一任务链" })).toBeNull();
    expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
    expect(sectionTabs().getByRole("tab", { name: "标签" })).toHaveAttribute("aria-selected", "true");
    selectTasks();
    expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
  });

  it("clears a blocking valid tag for overview navigation using the same member's status", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    vi.mocked(resolveProjectTags).mockResolvedValue([{ id: E, name: "后端" }]);
    graphRequest.mockResolvedValue(graph());
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === A ? [{ id: E, name: "后端" }] : [] })) });
    });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<ProjectPage projectId={projectId} />); selectTasks();
      await findListButton("已完成根");
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      selectStatus('todo');
      expect(chainList().queryByRole("button", { name: "已完成根" })).toBeNull();
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /已完成根.*前往任务列表/ }));
      await waitFor(() => expect(listButton("已完成根")).toHaveFocus());
      expect(screen.queryByRole("button", { name: "移除 后端" })).toBeNull();
      expect(statusTrigger()).toHaveTextContent(statusLabel('todo'));
      expect(screen.getByTestId("root-list")).toHaveAttribute("data-index-roots", expect.stringContaining(C));
    } finally { HTMLElement.prototype.scrollIntoView = scroll; }
  });

  it("preserves a matching tag during overview navigation and keeps invalid tags visible", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    let missing = false;
    vi.mocked(resolveProjectTags).mockImplementation(async () => {
      if (missing) throw new ApiError("server", 404, "tag_not_found");
      return [{ id: E, name: "后端" }];
    });
    graphRequest.mockResolvedValue(graph());
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === B ? [{ id: E, name: "后端" }] : [] })) });
    });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<ProjectPage projectId={projectId} />); selectTasks();
      await findListButton("已完成根");
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      selectStatus('todo');
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /已完成根.*前往任务列表/ }));
      await waitFor(() => expect(listButton("已完成根")).toHaveFocus());
      expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
      expect(statusTrigger()).toHaveTextContent(statusLabel('todo'));

      missing = true;
      vi.mocked(listProjectTags).mockResolvedValue({ items: [], catalogEpoch: F, nextCursor: null });
      fireEvent.focus(window);
      await screen.findByText("选中的标签已不可用，请移除后重新查询。");
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /已完成根.*前往任务列表/ }));
      expect(screen.getByText("选中的标签已不可用，请移除后重新查询。")).toBeVisible();
      expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
      expect(screen.queryByText("对应的任务分组已不可见，请从任务列表选择任务。")).toBeNull();
    } finally { HTMLElement.prototype.scrollIntoView = scroll; }
  });

  it("rechecks a blocking tag before clearing it for overview navigation", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    let missing = false;
    vi.mocked(resolveProjectTags).mockImplementation(async () => {
      if (missing) throw new ApiError("server", 404, "tag_not_found");
      return [{ id: E, name: "后端" }];
    });
    graphRequest.mockResolvedValue(graph());
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === B ? [{ id: E, name: "后端" }] : [] })) });
    });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("已完成根");
    fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
    fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
    await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
    fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
    missing = true;
    fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /另一任务链.*前往任务列表/ }));
    await screen.findByText("选中的标签已不可用，请移除后重新查询。");
    expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
    expect(screen.queryByText("对应的任务分组已不可见，请从任务列表选择任务。")).toBeNull();
  });

  it("retains selection on a failed or stale overview tag check", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    const check = deferred<readonly { id: string; name: string }[]>();
    let mode: "normal" | "failure" | "pending" = "normal";
    vi.mocked(resolveProjectTags).mockImplementation(async () => {
      if (mode === "failure") throw new ApiError("network");
      if (mode === "pending") return check.promise;
      return [{ id: E, name: "后端" }];
    });
    graphRequest.mockResolvedValue(graph());
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === B ? [{ id: E, name: "后端" }] : [] })) });
    });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("已完成根");
    fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
    fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
    await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
    fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
    const target = () => within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /另一任务链.*前往任务列表/ });
    mode = "failure"; fireEvent.click(target());
    expect(await screen.findByText("无法核对选中的标签，请重试。")).toBeVisible();
    expect(sectionTabs().getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    mode = "pending"; fireEvent.click(target());
    selectTasks();
    expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除 后端" }));
    await act(async () => { check.resolve([{ id: E, name: "后端" }]); await check.promise; });
    expect(sectionTabs().getByRole("tab", { name: "任务列表" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("对应的任务分组已不可见，请从任务列表选择任务。")).toBeNull();
  });

  it("rechecks identity before publishing failed verification and aborts on access uncertainty", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    let mode: "normal" | "failure" | "pending" = "normal", checkSignal: AbortSignal | undefined;
    const pending = deferred<readonly { id: string; name: string }[]>();
    vi.mocked(resolveProjectTags).mockImplementation(async (_project, _ids, signal) => {
      if (mode === "failure") { checkSignal = signal; throw new ApiError("network"); }
      if (mode === "pending") { checkSignal = signal; return pending.promise; }
      return [{ id: E, name: "后端" }];
    });
    graphRequest.mockResolvedValue(graph());
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === B ? [{ id: E, name: "后端" }] : [] })) });
    });
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = localeRender(<ProjectPage projectId={projectId} />, { taskCache: { scope } });
    try {
      selectTasks(); await findListButton("已完成根");
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      const ready = scope.ready.bind(scope), gate = deferred<void>();
      let waiting = false;
      vi.spyOn(scope, "ready").mockImplementation(async signal => {
        if (signal === checkSignal && mode === "failure") { waiting = true; await gate.promise; }
        await ready(signal);
      });
      const target = () => within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /另一任务链.*前往任务列表/ });
      mode = "failure"; fireEvent.click(target());
      await waitFor(() => expect(waiting).toBe(true));
      expect(screen.queryByText("无法核对选中的标签，请重试。")).toBeNull();
      await act(async () => { gate.resolve(); await gate.promise; });
      expect(await screen.findByText("无法核对选中的标签，请重试。")).toBeVisible();
      mode = "pending"; checkSignal = undefined; fireEvent.click(target());
      await waitFor(() => expect(checkSignal).toBeDefined());
      const signal = checkSignal!;
      act(() => (scope as unknown as { emit: (event: { projectId: string; directAccessUncertain: true }) => void }).emit({ projectId, directAccessUncertain: true }));
      expect(signal.aborted).toBe(true);
      await act(async () => { pending.resolve([{ id: E, name: "后端" }]); await pending.promise; });
      expect(sectionTabs().getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    } finally { view.unmount(); scope.dispose(); }
  });

  it("abandons a pending overview tag check when the overview page changes", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 1, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    const pending = deferred<readonly { id: string; name: string }[]>();
    let hold = false, checkSignal: AbortSignal | undefined;
    vi.mocked(resolveProjectTags).mockImplementation(async (_project, _ids, signal) => {
      if (hold) { checkSignal = signal; return pending.promise; }
      return [{ id: E, name: "后端" }];
    });
    const taskId = (i: number) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const items: Seed[] = Array.from({ length: 21 }, (_, i) => [
      { id: taskId(i * 2 + 1), title: `Chain ${i}`, status: "todo" as const, dependsOn: [] },
      { id: taskId(i * 2 + 2), title: `Child ${i}`, status: "todo" as const, dependsOn: [taskId(i * 2 + 1)] },
    ]).flat();
    graphRequest.mockResolvedValue(graph(items));
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(items); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id === taskId(1) ? [{ id: E, name: "后端" }] : [] })) });
    });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<ProjectPage projectId={projectId} />); selectTasks();
      await findListButton("Chain 1");
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      hold = true;
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /Chain 1，/ }));
      await waitFor(() => expect(checkSignal).toBeDefined());
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: "下一页" }));
      expect(checkSignal!.aborted).toBe(true);
      await act(async () => { pending.resolve([{ id: E, name: "后端" }]); await pending.promise; });
      expect(sectionTabs().getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
      selectTasks(); expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
    } finally { HTMLElement.prototype.scrollIntoView = scroll; }
  });

  it("keeps the target page after overview navigation clears a blocking tag", async () => {
    const tag = { id: E, name: "后端", projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 21, goals: 0 } };
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag], catalogEpoch: A, nextCursor: null });
    vi.mocked(resolveProjectTags).mockResolvedValue([{ id: E, name: "后端" }]);
    const taskId = (i: number) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const items: Seed[] = Array.from({ length: 22 }, (_, i) => [
      { id: taskId(i * 2 + 1), title: `Chain ${i}`, status: "todo" as const, dependsOn: [] },
      { id: taskId(i * 2 + 2), title: `Child ${i}`, status: "todo" as const, dependsOn: [taskId(i * 2 + 1)] },
    ]).flat();
    graphRequest.mockResolvedValue(graph(items));
    vi.mocked(getTaskSync).mockImplementation(async (id, query) => {
      const source = graph(items); servedGraphs.set(id, source);
      const sync = syncFixture.toSync(source, query);
      return taskSyncReadFixture({ ...sync, tasks: sync.tasks.map(task => ({ ...task, tags: task.id !== taskId(1) && task.id !== taskId(2) ? [{ id: E, name: "后端" }] : [] })) });
    });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<ProjectPage projectId={projectId} />); selectTasks();
      await findListButton("Chain 21");
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      const chainPagination = () => within(screen.getByRole("navigation", { name: "任务链列表分页" }));
      fireEvent.click(chainPagination().getByRole("button", { name: "下一页" }));
      expect(chainPagination().getByText(/第 2 \/ 2 页/)).toBeVisible();
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      const overview = within(document.getElementById("project-overview-progress")!);
      fireEvent.click(overview.getByRole("button", { name: "下一页" }));
      fireEvent.click(overview.getByRole("button", { name: /Chain 0，/ }));
      await waitFor(() => expect(listButton("Chain 0")).toHaveFocus());
      expect(chainPagination().getByText(/第 2 \/ 2 页/)).toBeVisible();
      expect(screen.queryByRole("button", { name: "移除 后端" })).toBeNull();
    } finally { HTMLElement.prototype.scrollIntoView = scroll; }
  });

  it("restarts an invalid search only after removing the missing tag and resolving the remainder", async () => {
    const tag = (id: string, name: string) => ({ id, name, projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } });
    vi.mocked(listProjectTags).mockResolvedValue({ items: [tag(E, "已删除"), tag(F, "保留")], catalogEpoch: A, nextCursor: null });
    let missing = false;
    vi.mocked(resolveProjectTags).mockImplementation(async (_project, ids) => {
      if (missing && ids.includes(E)) throw new ApiError("server", 404, "tag_not_found");
      return ids.map(id => ({ id, name: id === E ? "已删除" : "保留" }));
    });
    graphRequest.mockResolvedValue(graph());
    vi.mocked(searchTasks).mockImplementationOnce(async () => { missing = true; throw new ApiError("server", 400, "invalid_tag_filter"); })
      .mockResolvedValue({ projectId, total: 0, items: [], nextCursor: null });
    render(<ProjectPage projectId={projectId} />); selectTasks(); await findListButton("另一任务链");
    fireEvent.click(screen.getByText("标签筛选", { selector: "summary > span:first-child" }).closest('summary')!);
    fireEvent.click(await screen.findByRole("checkbox", { name: "已删除" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "保留" }));
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "query" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByText("选中的标签已不可用，请移除后重新查询。");
    await waitFor(() => expect(screen.getByRole("button", { name: "移除 已删除" }).parentElement).toHaveTextContent("已删除 · 已不可用"));
    expect(searchTasks).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "移除 已删除" }));
    await waitFor(() => expect(searchTasks).toHaveBeenCalledTimes(2));
    expect(vi.mocked(searchTasks).mock.calls[1]![2]).toMatchObject({ tagIds: [F], tagMatch: "all" });
    expect(screen.queryByText("选中的标签已不可用，请移除后重新查询。")).toBeNull();
  });
  it("retains the search draft and focus when the first graph sample arrives", async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValue(pending.promise);
    render(<ProjectPage projectId={projectId} />); selectTasks();
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "unfinished search" } });
    input.focus();
    await act(async () => { pending.resolve(graph()); });
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    expect(searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" })).toBe(input);
    expect(input).toHaveValue("unfinished search");
    expect(input).toHaveFocus();
  });

  it("keeps search available without a graph and opens a hit with direct observation", async () => {
    graphRequest.mockRejectedValue(new ApiError("network"));
    vi.mocked(searchTasks).mockResolvedValue({ projectId, total: 1, nextCursor: null, items: [{ tags: [{ id: A, name: "搜索标签" }], type: "task", parentId: A, id: X, projectId, title: "完整的历史任务", status: "done", assignedTo: null, updatedAt: time, cancelledAt: null, context: { taskId: A, title: "原任务链" }, match: { fields: ["id", "description"], descriptionSnippet: "匹配描述" } }] });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.click(searchForm().getByRole("button", { name: "搜索语法" }));
    expect(screen.getByText(/id:、title: 和 description:/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "历史" } });
    expect(searchTasks).not.toHaveBeenCalled();
    fireEvent.submit(input.closest("form")!);
    const result = await waitFor(() => searchResults().getByRole("button", { name: "打开任务：完整的历史任务" }));
    expect(screen.getByText("原任务链", { exact: false })).toBeTruthy();
    expect(result).toHaveTextContent("ID 命中 · 描述命中 · 匹配描述");
    expect(result).toHaveTextContent("搜索标签");
    expect(result).toHaveTextContent(X);
    fireEvent.click(result);
    expect(screen.getByTestId("selected-task")).toHaveTextContent(X);
    expect(screen.getByTestId("observation-kind")).toHaveTextContent("direct");
    fireEvent.click(detail().getByRole("button", { name: "关闭详情" }));
    expect(result).toHaveFocus();
  });

  it("keeps draft edits separate and restores ordinary task state on clear", async () => {
    graphRequest.mockResolvedValue(graph());
    vi.mocked(searchTasks).mockResolvedValue({ projectId, total: 0, items: [], nextCursor: null });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("另一任务链");
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "缓存" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByText("未找到匹配任务");
    fireEvent.change(input, { target: { value: "未提交" } });
    expect(screen.getByText("搜索结果：缓存")).toBeTruthy();
    expect(searchTasks).toHaveBeenCalledTimes(1);
    fireEvent.click(searchForm().getByRole("button", { name: "清空搜索" }));
    expect(listButton("另一任务链")).toBeTruthy();
    expect(input).toHaveFocus();
  });

  it("clears an applied search when the draft is deleted, cancelling an in-flight read", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<typeof searchTasks>>>();
    const hit = { tags: [], type: "task" as const, parentId: null, id: X, projectId, title: "搜索命中", status: "todo" as const, assignedTo: null, updatedAt: time, cancelledAt: null, context: null, match: { fields: ["title" as const], descriptionSnippet: null } };
    graphRequest.mockResolvedValue(graph());
    vi.mocked(searchTasks).mockResolvedValueOnce({ projectId, total: 1, items: [hit], nextCursor: null }).mockReturnValueOnce(pending.promise);
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("另一任务链");
    selectStatus('todo');
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    await user.type(input, "缓存{Enter}");
    await screen.findByRole("button", { name: "打开任务：搜索命中" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(searchTasks).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(searchTasks).mock.calls[1]![4];
    await user.keyboard("{Control>}a{/Control}未提交");
    expect(screen.getByText("搜索结果：缓存")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开任务：搜索命中" })).toBeTruthy();
    expect(signal.aborted).toBe(false);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(input).toHaveValue(""); expect(input).toHaveFocus();
    expect(signal.aborted).toBe(true);
    expect(document.querySelector(".task-search-results")).toBeNull();
    expect(document.querySelector(".task-search-filters")).toBeNull();
    expect(taskTabs().getByRole("tab", { name: "任务链" })).toBeVisible();
    expect(statusTrigger()).toHaveTextContent(statusLabel('todo'));
    expect(listButton("另一任务链")).toBeTruthy();
    await act(async () => { pending.resolve({ projectId, total: 1, items: [{ ...hit, title: "迟到结果" }], nextCursor: null }); });
    expect(screen.queryByRole("button", { name: "打开任务：迟到结果" })).toBeNull();
    expect(document.querySelector(".task-search-results")).toBeNull();
    expect(searchTasks).toHaveBeenCalledTimes(2);
  });

  it("reports syntax errors and selects the Unicode location in the submitted expression", async () => {
    graphRequest.mockResolvedValue(graph());
    vi.mocked(searchTasks).mockRejectedValue(new TaskSearchError(400, "invalid_search_expression", "search-request", { reason: "unexpected_closing_group", position: 4, length: 1 }));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "😀中 )" } }); fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("搜索语法第 4 个字符：多余的右括号。")).toBeTruthy();
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 5]);
    expect(screen.queryByText("未找到匹配任务")).toBeNull();
  });

  it("retains pagination focus while the next page is loading and after it arrives", async () => {
    graphRequest.mockResolvedValue(graph());
    const pending = deferred<Awaited<ReturnType<typeof searchTasks>>>();
    const item = { tags: [], type: "task" as const, parentId: null, id: A, projectId, title: "第一页", status: "todo" as const, assignedTo: null, updatedAt: time, cancelledAt: null, context: null, match: { fields: ["title" as const], descriptionSnippet: null } };
    vi.mocked(searchTasks).mockResolvedValueOnce({ projectId, total: 16, items: Array.from({ length: 15 }, (_, index) => ({ ...item, id: `page-one-${index}`, title: index === 0 ? item.title : `第一页 ${index}` })), nextCursor: "next" }).mockReturnValueOnce(pending.promise);
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "页" } }); fireEvent.submit(input.closest("form")!);
    await waitFor(() => searchResults().getByRole("button", { name: "打开任务：第一页" }));
    const next = within(document.querySelector<HTMLElement>(".task-search-results .list-pagination")!).getByRole("button", { name: "下一页" }); next.focus(); fireEvent.click(next);
    expect(next).toHaveFocus(); expect(next).toHaveAttribute("aria-disabled", "true");
    await act(async () => { pending.resolve({ projectId, total: 16, items: [{ ...item, id: B, title: "第二页" }], nextCursor: null }); });
    expect(await waitFor(() => searchResults().getByRole("button", { name: "打开任务：第二页" }))).toBeTruthy();
    expect(next).toHaveFocus(); expect(next).toHaveAttribute("aria-disabled", "true");
  });

  it("exits search before navigating from overview to a task chain", async () => {
    graphRequest.mockResolvedValue(graph());
    vi.mocked(searchTasks).mockResolvedValue({ projectId, total: 0, items: [], nextCursor: null });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "缓存" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByText("未找到匹配任务");
    fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
    document.getElementById(`task-root-${C}`)!.scrollIntoView = vi.fn();
    fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /另一任务链.*前往任务列表/ }));
    expect(listButton("另一任务链")).toHaveFocus();
    expect(input).toHaveValue("");
    expect(screen.queryByText("未找到匹配任务")).toBeNull();
  });

  it("does not steal focus or selection when a syntax error is repeated by a background check", async () => {
    graphRequest.mockResolvedValue(graph());
    let currentSearch!: TaskSearchModule.TaskSearchController;
    const useTaskSearch = TaskSearchModule.useTaskSearch;
    vi.spyOn(TaskSearchModule, "useTaskSearch").mockImplementation((...args) => {
      currentSearch = useTaskSearch(...args);
      return currentSearch;
    });
    const errors: TaskSearchError[] = [];
    vi.mocked(searchTasks).mockImplementation(async () => {
      const failure = new TaskSearchError(400, "invalid_search_expression", "search-request", { reason: "unexpected_closing_group", position: 4, length: 1 });
      errors.push(failure);
      throw failure;
    });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "😀中 )" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByText("搜索语法第 4 个字符：多余的右括号。");
    input.setSelectionRange(0, 0); const help = searchForm().getByRole("button", { name: "搜索语法" }); help.focus();
    fireEvent(document, new Event("visibilitychange"));
    await waitForState(() => expect(searchTasks).toHaveBeenCalledTimes(2));
    await waitForState(() => expect(currentSearch.error).toBe(errors[1]));
    await waitFor(() => expect(help).toHaveFocus());
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0]);
  });

  it("opens the selected task Session in the project reader", async () => {
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    const shortcut = await findListButton(`进入会话 ${A}`);
    shortcut.focus(); fireEvent.click(shortcut);
    expect(await screen.findByLabelText('详情测试外壳')).toBeVisible();
    expect(detail().getByTestId('selected-task')).toHaveTextContent(A);
    expect(detail().getByTestId('detail-tab')).toHaveTextContent('session');
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    expect(window.location.search).toBe('?tab=tasks');
    fireEvent.click(detail().getByRole('button', { name: '关闭详情' }));
    await waitFor(() => expect(screen.queryByLabelText('详情测试外壳')).toBeNull());
    expect(shortcut).toHaveFocus();
  });

  beforeEach(() => { window.localStorage.setItem(`daynight:completed-chains:${projectId}`, "true"); });
  beforeEach(() => { rememberRoot(A); });

  it("loads a complete graph into seven accurate task statistics and opens a chain only on request", async () => {
    window.localStorage.clear();
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(pending.promise);
    render(<ProjectPage projectId={projectId} />); selectTasks();
    expect(screen.getByRole("status", { name: "正在加载任务图" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "项目任务统计" })).toBeNull();
    await act(async () => { pending.resolve(graph()); });
    expect(await screen.findByRole("heading", { name: "核心项目" })).toBeTruthy(); await waitForGraph();
    expect(["任务总数", "已完成", "待确认", "待处理", "进行中", "可开始", "未就绪"].map(number)).toEqual(["4", "1", "0", "3", "0", "2", "1"]);
    const cards = document.querySelectorAll(".stats .stat");
    expect(cards).toHaveLength(7);
    for (const card of cards) expect([...card.children].map(child => child.className)).toEqual(["stat-label", "stat-number"]);
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(screen.getByText("git@github.com:example/project.git")).toBeTruthy();
    expect(screen.getByText(/最近成功刷新/).closest("time")?.getAttribute("datetime")).not.toBe(time);
    fireEvent.click(listButton("已完成根"));
    expect(screen.getByTestId(`chain-${A}`)).toBeTruthy();
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    fireEvent.click(chainDialog().getByRole("button", { name: "关闭依赖图" }));
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it("retains the snapshot and receipt time on refresh failure and keeps a valid open chain", async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    fireEvent.click(listButton("另一任务链"));
    const receipt = screen.getByText(/最近成功刷新/).closest("time")?.getAttribute("datetime");
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    expect(titleActions().getByRole("button", { name: "正在刷新…" })).toBeDisabled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(number("任务总数")).toBe("4");
    await waitForState(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    await act(async () => { pending.reject(new ApiError("server", 500, "internal_error", "refresh-request")); });
    expect((await screen.findByRole("alert")).textContent).toContain("仍显示上次成功读取的数据");
    expect(within(screen.getByRole("alert")).getByText("refresh-request")).toBeTruthy();
    expect(screen.getByText(/最近成功刷新/).closest("time")?.getAttribute("datetime")).toBe(receipt);
    expect(screen.getByTestId(`chain-${C}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试刷新" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByTestId(`chain-${C}`)).toBeTruthy();
  });

  it.each(['failure', 'child'] as const)('opens an old cached task fragment when synchronization ends in %s', async (outcome) => {
    const source = graph([seeds[0]!]);
    const cached = { ...source, tasks: source.tasks.map(({ parentTaskId: _parentTaskId, ...task }) => task) };
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(cached).mockReturnValueOnce(pending.promise);
    const first = render(<ProjectPage projectId={projectId} />);
    await waitForGraph();
    first.unmount();
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks#task=${A}`);
    dispatchEvent(new PopStateEvent('popstate'));
    render(<ProjectPage projectId={projectId} />);
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('selected-task')).toHaveTextContent(A);
    expect(screen.getByTestId('observation-kind')).toHaveTextContent('direct');
    expect(location.hash).toBe('');
    await act(async () => {
      if (outcome === 'failure') pending.reject(new ApiError('network'));
      else pending.resolve({ ...source, tasks: source.tasks.map(task => ({ ...task, parentTaskId: F })) });
    });
    expect(screen.getByTestId('selected-task')).toHaveTextContent(A);
    expect(screen.queryByText('对应的任务分组已不可见，请从任务列表选择任务。')).toBeNull();
  });

  it('keeps Goal navigation for a cached Goal member with no ordinary-parent field', async () => {
    const source = graph([{ id: A, title: 'Goal member', status: 'todo', dependsOn: [] }, { id: B, title: 'Goal owner', status: 'todo', dependsOn: [] }]);
    const cached = { ...source, tasks: source.tasks.map(({ parentTaskId: _parentTaskId, ...task }) => task.id === A ? { ...task, parentId: B } : { ...task, type: 'goal' as const }) };
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(cached).mockReturnValueOnce(pending.promise);
    const first = render(<ProjectPage projectId={projectId} />);
    await waitForGraph();
    first.unmount();
    history.replaceState(null, '', `/projects/${projectId}?tab=tasks#task=${A}`);
    dispatchEvent(new PopStateEvent('popstate'));
    render(<ProjectPage projectId={projectId} />);
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(cached));
    expect(await screen.findByTestId('selected-task')).toHaveTextContent(B);
  });

  it("reopens durable task data before background sync and admits details only after its live receipt", async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(pending.promise);
    const first = render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    first.unmount();

    render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "核心项目" });
    await waitForState(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    expect(number("任务总数")).toBe("4");
    expect(screen.queryByRole("status", { name: "正在加载任务图" })).toBeNull();
    expect(screen.queryByText(/最近成功刷新/)).toBeNull();
    fireEvent.click(listButton("已完成根"));
    fireEvent.click(await findNodeButton("节点 后续任务"));
    expect(screen.getByTestId("detail-state")).toHaveTextContent("loading");
    expect(detailRequest).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(graph(seeds.map((task) => task.id === B ? { ...task, status: "done" } : task))); });
    await waitFor(() => expect(number("已完成")).toBe("2"));
    await waitFor(() => expect(screen.getByTestId("detail-state")).toHaveTextContent("ready"));
    expect(screen.getByTestId("detail-business-status")).toHaveTextContent("done");
    expect(screen.getByTestId(`chain-${A}`)).toBeTruthy();
    expect(screen.getByText(/最近成功刷新/)).toBeTruthy();
    expect(detailRequest).toHaveBeenCalledOnce();
  });

  it("dismisses a vanished-task notice across refreshes and shows a new removal without changing the view", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([seeds[2]!, seeds[3]!])));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    const trigger = await findNodeButton("节点 后续任务");
    trigger.focus(); fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    fireEvent.click(detail().getByRole("button", { name: "刷新全图" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(await screen.findByText("所选任务已不在新的任务图中，详情已关闭。")).toBeTruthy();
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(document.activeElement).toBe(taskTabs().getByRole("tab", { name: "任务链" }));
    expect(number("任务总数")).toBe("2");
    const preferences = { ...window.localStorage };
    const requests = graphRequest.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByText("所选任务已不在新的任务图中，详情已关闭。")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(sectionTabs().getByRole("tab", { name: "任务列表" })).toHaveAttribute("aria-selected", "true");
    expect(taskTabs().getByRole("tab", { name: "任务链" })).toHaveAttribute("aria-selected", "true");
    expect(number("任务总数")).toBe("2");
    expect(window.localStorage).toMatchObject(preferences);
    expect(graphRequest).toHaveBeenCalledTimes(requests);
    expect(screen.getByRole("heading", { name: "核心项目" })).toHaveFocus();

    graphRequest.mockResolvedValue(graph([seeds[2]!, seeds[3]!]));
    fireEvent.click(await waitFor(() => titleActions().getByRole("button", { name: "刷新" })));
    await waitForState(() => expect(graphRequest).toHaveBeenCalledTimes(requests + 1));
    await waitFor(() => expect(titleActions().getByRole("button", { name: "刷新" })).toBeEnabled());
    expect(screen.queryByText("所选任务已不在新的任务图中，详情已关闭。")).toBeNull();

    await openChain("另一任务链");
    fireEvent.click(chainDialog().getByRole("button", { name: "节点 阻塞任务" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("阻塞任务"));
    graphRequest.mockResolvedValue(resetSnapshot(graph([])));
    fireEvent.click(detail().getByRole("button", { name: "刷新全图" }));
    expect(await screen.findByRole("button", { name: "关闭提示" })).toBeVisible();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("reuses a retained detail after an unchanged graph receipt without patching graph statistics", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    fireEvent.click(await findNodeButton("节点 后续任务"));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    expect(detailRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("detail-business-status").textContent).toBe("todo");
    expect(number("已完成")).toBe("1");
    fireEvent.click(detail().getByRole("button", { name: "刷新全图" }));
    await waitForState(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(titleActions().getByRole("button", { name: "刷新" })).toBeEnabled());
    expect(detailRequest).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected-task").textContent).toBe(B);
    expect(number("已完成")).toBe("1");
  });

  it("preserves the original node focus when closing a pending unknown relation after relation navigation", async () => {
    const unknown = deferred<TaskDetail>();
    const resolveDetail = detailRequest.getMockImplementation()!;
    detailRequest.mockImplementation((...args) => args[1] === X ? unknown.promise : resolveDetail(...args));
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    const trigger = await findNodeButton("节点 后续任务");
    trigger.focus(); fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    fireEvent.click(detail().getByRole("button", { name: "关系跳转" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("另一任务链"));
    expect(screen.getByTestId("selected-task").textContent).toBe(C);
    fireEvent.click(detail().getByRole("button", { name: "未知关系" }));
    await waitForState(() => expect(detailRequest.mock.calls.at(-1)?.[1]).toBe(X));
    expect(screen.getByTestId("selected-task")).toHaveTextContent(X);
    expect(screen.getByTestId("detail-title")).toBeEmptyDOMElement();
    fireEvent.click(detail().getByRole("button", { name: "关闭详情" }));
    expect(document.activeElement).toBe(trigger);
    await act(async () => { unknown.resolve(await resolveDetail(...detailRequest.mock.calls.at(-1)!)); });
  });

  it("falls back to the task section tab when the selected chain disappears into an empty snapshot", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([])));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    fireEvent.click(await findNodeButton("节点 后续任务"));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    fireEvent.click(detail().getByRole("button", { name: "刷新全图" }));
    await waitFor(() => expect(number("任务总数")).toBe("0"));
    await waitFor(() => expect(document.activeElement).toBe(taskTabs().getByRole("tab", { name: "任务链" })));
    expect(screen.getByTestId("root-list")).toBeEmptyDOMElement();
  });

  it("clears project-specific display immediately when the project prop changes", async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(pending.promise);
    const view = render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
    act(() => browserNavigation().navigate(`/projects/${otherProject}`));
    view.rerender(<ProjectPage projectId={otherProject} />); selectTasks();
    expect(screen.queryByRole("heading", { name: "核心项目" })).toBeNull();
    expect(screen.queryByRole("region", { name: "项目任务统计" })).toBeNull();
    await act(async () => { pending.resolve(graph(seeds, otherProject)); });
    expect(await screen.findByRole("heading", { name: "另一个项目" })).toBeTruthy();
  });

  it("renders an empty project as zero statistics and an explicit empty state", async () => {
    graphRequest.mockResolvedValue(graph([]));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await waitFor(() => expect(number("任务总数")).toBe("0"));
    expect(taskTabs().getByRole("tab", { name: "Goal" })).toBeVisible();
    expect(["任务总数", "已完成", "待确认", "待处理", "进行中", "可开始", "未就绪"].map(number)).toEqual(["0", "0", "0", "0", "0", "0", "0"]);
  });

  it.each([
    [new ApiError("server", 404, "not_found", "missing-project"), "项目不存在", "这个项目不存在，请返回项目列表。"],
    [new ApiError("network"), "项目加载失败", "无法连接服务，请检查本地服务后重试。"],
    [new ApiError("protocol", 200), "任务图数据不完整", "任务图数据不完整或不一致，请重试。"],
  ] as const)("shows safe first-load errors without zero-stat fallbacks %#", async (failure, heading, message) => {
    graphRequest.mockRejectedValueOnce(failure).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    const alert = (await screen.findByRole("heading", { name: heading })).closest<HTMLElement>("[role=alert]")!;
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(screen.queryByText("任务总数")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "核心项目" }); await waitForGraph();
  });

  it("shows generic read failures and rejects malformed graph snapshots", async () => {
    graphRequest.mockRejectedValueOnce(new ApiError("server", 500, "internal_error", "graph-read-failed"))
      .mockResolvedValueOnce({ ...graph(), tasks: graph().tasks.map((task) => task.id === B ? { ...task, dependsOn: [B] } : task) });
    render(<ProjectPage projectId={projectId} />); selectTasks();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "项目加载失败" })).toBeTruthy();
    expect(alert.textContent).toContain("graph-read-failed");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "任务图数据不完整" });
    expect(screen.queryByText("任务总数")).toBeNull();
  });

  it("renders untrusted project values as plain text and preserves modified return clicks", async () => {
    graphRequest.mockResolvedValue(graph([]));
    vi.mocked(getProject).mockResolvedValue({ ...graph().project, name: "<img src=x onerror=alert(1)>", repoUrl: "javascript:alert(1)" });
    const view = render(<ProjectPage projectId={projectId} />); selectTasks();
    await screen.findByRole("heading", { name: "<img src=x onerror=alert(1)>" });
    expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "← 项目" });
    const observe = (event: Event) => { expect(event.defaultPrevented).toBe(false); event.preventDefault(); };
    document.addEventListener("click", observe, { once: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/projects");
  });
});

describe("status-first task chains", () => {
  beforeEach(() => { window.localStorage.setItem(`daynight:completed-chains:${projectId}`, "true"); });
  const presentedRoots = () => [...screen.getByTestId("root-list").querySelectorAll('[id^="task-root-"]')].map((root) => root.id);
  const newerRoots: readonly Seed[] = [
    { id: E, title: "新任务链", status: "todo", dependsOn: [] },
    { id: F, title: "最新任务链", status: "todo", dependsOn: [] },
    { id: X, title: "新增跨链后续", status: "todo", dependsOn: [E, F], externalDependsOn: [E] },
    { id: Y, title: "新任务链后续", status: "todo", dependsOn: [E] },
  ];

  it("reverses exact API root order across equal and sub-millisecond timestamps with children interspersed", async () => {
    const ordered = graph([
      { id: A, title: "最早任务链", status: "done", dependsOn: [] },
      { id: B, title: "已完成后续", status: "done", dependsOn: [A] },
      { id: C, title: "稍早任务链", status: "done", dependsOn: [] },
      { id: D, title: "最新后续任务", status: "todo", dependsOn: [B, C] },
      ...newerRoots,
    ]);
    const timestamps = ["123454", "123455", "123455", "123456", "123456", "123456", "123456", "123456"];
    const snapshot = { ...ordered, tasks: Object.freeze(ordered.tasks.map((task, position) => ({
      ...task, createdAt: `2026-10-20T12:00:00.${timestamps[position]}Z`,
      updatedAt: task.id === A ? "2026-10-22T12:00:00Z" : task.updatedAt,
    }))) };
    expect(new Set(snapshot.tasks.map((task) => Date.parse(task.createdAt))).size).toBe(1);
    graphRequest.mockResolvedValue(snapshot);
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("最新任务链");
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(presentedRoots()).toEqual([A, F, E].map((id) => `task-root-${id}`));
    expect(screen.getByTestId("root-list")).toHaveAttribute("data-index-roots", [A, E, F].join(","));
    expect(snapshot.tasks.map((task) => task.id)).toEqual([A, B, C, D, E, F, X, Y]);
    await openChain("最早任务链");
    const chain = screen.getByTestId(`chain-${A}`);
    expect(within(chain).getAllByRole("button").slice(1).map((button) => button.textContent)).toEqual(["节点 最早任务链", "节点 已完成后续", "节点 稍早任务链", "节点 最新后续任务"]);
    expect(number("任务总数")).toBe("8");
    expect(number("已完成")).toBe("3");
  });

  it("retains an explicitly opened older chain when newer chains arrive and closes it when it disappears", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([...seeds, ...newerRoots]))
      .mockResolvedValueOnce(resetSnapshot(graph([seeds[2]!, seeds[3]!, ...newerRoots])));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    await findListButton("最新任务链");
    expect(presentedRoots()).toEqual([A, F, E, C].map((id) => `task-root-${id}`));
    expect(screen.getByTestId(`chain-${A}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${F}`)).toBeNull();
    await waitFor(() => expect(titleActions().getByRole("button", { name: "刷新" })).toBeEnabled());
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(presentedRoots()).toEqual([F, E, C].map((id) => `task-root-${id}`)));
    expect(presentedRoots()).toEqual([F, E, C].map((id) => `task-root-${id}`));
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(window.localStorage.getItem(preferenceKey())).toBeNull();
  });

  it("keeps a closed list closed when newer chains arrive", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([...seeds, ...newerRoots]));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("另一任务链");
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    await findListButton("最新任务链");
    expect(presentedRoots()).toEqual([A, F, E, C].map((id) => `task-root-${id}`));
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(window.localStorage.getItem(preferenceKey())).toBeNull();
  });
});

describe("transient task chain dialogs", () => {
  const joined = () => graph(seeds.map((task) => task.id === C ? { ...task, dependsOn: [A] } : task));

  it("retains the clicked witness through component merges and splits during the same visit", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(joined()).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("另一任务链");
    expect(screen.getByTestId(`chain-${C}`)).toBeVisible();
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    await waitFor(() => expect(titleActions().getByRole("button", { name: "刷新" })).toBeEnabled());
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
    expect(window.localStorage.getItem(preferenceKey())).toBeNull();
  });

  it("starts closed after remounting and project navigation regardless of previous open dialogs", async () => {
    graphRequest.mockImplementation(async (id) => graph(seeds, id));
    let view = render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    expect(screen.getByTestId(`chain-${A}`)).toBeVisible();
    view.unmount();
    browserNavigation().dispose(); // A new document does not restore private reading history.
    view = render(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("已完成根");
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    await openChain("另一任务链");
    act(() => browserNavigation().navigate(`/projects/${otherProject}`));
    view.rerender(<ProjectPage projectId={otherProject} />); selectTasks();
    await findListButton("另一任务链");
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    await openChain("另一任务链");
    act(() => browserNavigation().navigate(`/projects/${projectId}`));
    view.rerender(<ProjectPage projectId={projectId} />); selectTasks();
    await findListButton("已完成根");
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
  });

  it.each(["{", "null", "[]", "{}", JSON.stringify({ expandedRootId: A }), JSON.stringify({ expandedRootId: null })])(
    "ignores obsolete persisted expansion without reading, replacing or opening it (%s)", async (stored) => {
      window.localStorage.setItem(preferenceKey(), stored);
      const read = vi.spyOn(Storage.prototype, "getItem");
      const write = vi.spyOn(Storage.prototype, "setItem");
      graphRequest.mockResolvedValue(graph());
      render(<ProjectPage projectId={projectId} />); selectTasks();
      await findListButton("已完成根");
      expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
      expect(read.mock.calls.filter(([key]) => key === preferenceKey())).toHaveLength(0);
      await openChain("已完成根");
      expect(screen.getByTestId(`chain-${A}`)).toBeVisible();
      fireEvent.click(chainDialog().getByRole("button", { name: "关闭依赖图" }));
      expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
      expect(write.mock.calls.filter(([key]) => key === preferenceKey())).toHaveLength(0);
      expect(window.localStorage.getItem(preferenceKey())).toBe(stored);
    },
  );

  it("does not auto-open a chain when an empty project gains tasks", async () => {
    graphRequest.mockResolvedValueOnce(resetSnapshot(graph([]))).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await waitFor(() => expect(number("任务总数")).toBe("0"));
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    await findListButton("已完成根");
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
  });

  it("keeps an explicitly opened chain through refresh failure without persistence", async () => {
    const pending = deferred<TaskGraph>();
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    graphRequest.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new ApiError("network"));
    render(<ProjectPage projectId={projectId} />); selectTasks();
    expect(read.mock.calls.filter(([key]) => key === preferenceKey())).toHaveLength(0);
    await act(async () => { pending.resolve(graph()); });
    await openChain("已完成根");
    fireEvent.click(titleActions().getByRole("button", { name: "刷新" }));
    await screen.findByRole("alert");
    expect(screen.getByTestId(`chain-${A}`)).toBeVisible();
    expect(write.mock.calls.filter(([key]) => key === preferenceKey())).toHaveLength(0);
  });

  it("keeps opening and closing a chain independent from blocked browser storage", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Storage access denied", "SecurityError"); });
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    await openChain("已完成根");
    expect(screen.getByTestId(`chain-${A}`)).toBeVisible();
    fireEvent.click(chainDialog().getByRole("button", { name: "关闭依赖图" }));
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
  });
});
