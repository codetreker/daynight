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
import { listProjectTags, resolveProjectTags } from "../src/api/task-tags";
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
vi.mock("../src/api/task-tags", async (original) => ({ ...await original<typeof import("../src/api/task-tags")>(), listProjectTags: vi.fn(), resolveProjectTags: vi.fn() }));
vi.mock("../src/api/task-search", async (original) => ({ ...await original<typeof import("../src/api/task-search")>(), searchTasks: vi.fn() }));
vi.mock("../src/api/project-settings", async (original) => ({ ...await original<typeof import("../src/api/project-settings")>(), getProject: vi.fn() }));
vi.mock("../src/api/auth", async (original) => ({ ...await original<typeof import("../src/api/auth")>(), getProjectAccess: vi.fn() }));
vi.mock("../src/features/task-graph/ChainList", () => ({ ChainList: ({ index, representativeIds, openGraphTarget, onOpenChain, onCloseChain, onOpenTask, onOpenSession, pagination }: {
  index: GraphIndex; representativeIds: readonly string[]; openGraphTarget: { kind: 'chain'; witnessTaskId: string; rootId: string } | null; onOpenChain: (id: string, trigger: HTMLElement) => void; onCloseChain: () => void; onOpenTask: (id: string, trigger: HTMLElement) => void; onOpenSession?: (id: string, trigger: HTMLElement) => void; pagination?: PaginationState;
}) => <div data-testid="root-list" data-index-roots={index.representativeIds.join(",")}>{representativeIds.map((root) => <div key={root}>
  <button onClick={(event) => onOpenSession?.(root, event.currentTarget)}>进入会话 {root}</button>
  <button id={`task-root-${root}`} aria-haspopup="dialog" onClick={(event) => onOpenChain(root, event.currentTarget)}>{index.nodes.get(root)!.titlePreview}</button>
  {openGraphTarget?.kind === 'chain' && openGraphTarget.rootId === root && <div role="dialog" className="task-chain-dialog" id={`task-graph-${root}`} data-testid={`chain-${root}`}>
    <button className="task-chain-close" onClick={onCloseChain}>关闭依赖图</button>
    {[...projectChain(index, root).mainIds].map((id) => <button key={id} onClick={(event) => onOpenTask(id, event.currentTarget)}>节点 {index.nodes.get(id)!.titlePreview}</button>)}
  </div>}
</div>)}{pagination !== undefined && <ListPagination label="任务链列表" {...pagination} />}</div> }));
vi.mock("../src/features/task-detail/TaskDetailDialog", () => ({ TaskDetailDialog: ({ projectId, taskId, snapshot, observation, onSelectTask, onClose, onRestoreFocus, onRefreshGraph }: {
  projectId: string; taskId: string; snapshot: GraphSnapshot | null; observation: { kind: string }; onSelectTask: (id: string) => void; onClose: () => void; onRestoreFocus: () => void; onRefreshGraph: () => void;
}) => {
  const state = useTaskDetail(projectId, taskId, snapshot?.revision ?? 0, snapshot?.index.nodes.get(taskId));
  useEffect(() => () => onRestoreFocus(), [onRestoreFocus]);
  return <aside aria-label="详情测试外壳"><p data-testid="selected-task">{taskId}</p><p data-testid="observation-kind">{observation.kind}</p><p data-testid="detail-state">{state.status}</p><p data-testid="detail-title">{state.detail?.title}</p><p data-testid="detail-business-status">{state.detail?.status}</p>
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
    return { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: seed.externalDependsOn ?? [], startedAt: null, completedAt: null, cancelledAt: null, id: seed.id, titlePreview: seed.title, titleTruncated: false, status: seed.status, dependsOn: seed.dependsOn, blockedBy,
      ready: seed.status === "todo" && blockedBy.length === 0, createdAt: time, updatedAt: time };
  });
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id, name: id === projectId ? "核心项目" : "另一个项目", repoUrl: "git@github.com:example/project.git", createdAt: time, updatedAt: time }, tasks,
    summary: { proposed: 0, total: tasks.length, todo: tasks.filter((task) => task.status === "todo").length,
      done: tasks.filter((task) => task.status === "done").length, cancelled: 0, inProgress: tasks.filter((task) => task.status === "in_progress").length,
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.status === "todo" && !task.ready).length },
  };
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
    const filter = screen.getByText("标签筛选", { selector: "summary" });
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
    expect(chainList().getByRole("button", { name: "已完成根" })).toBeVisible();
    expect(chainList().queryByRole("button", { name: "另一任务链" })).toBeNull();
    expect(screen.getByTestId("root-list")).toHaveAttribute("data-index-roots", expect.stringContaining(C));
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "query" } }); fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(searchTasks).toHaveBeenCalledWith(projectId, "query", expect.objectContaining({ type: "task", tagIds: [E], tagMatch: "all" }), null, expect.anything(), expect.anything(), expect.anything()));
    fireEvent.click(searchForm().getByRole("button", { name: "清空搜索" }));
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
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      fireEvent.change(screen.getByRole("combobox", { name: "状态" }), { target: { value: "todo" } });
      expect(chainList().queryByRole("button", { name: "已完成根" })).toBeNull();
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /已完成根.*前往任务列表/ }));
      await waitFor(() => expect(listButton("已完成根")).toHaveFocus());
      expect(screen.queryByRole("button", { name: "移除 后端" })).toBeNull();
      expect(screen.getByRole("combobox", { name: "状态" })).toHaveValue("todo");
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
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
      fireEvent.click(await screen.findByRole("checkbox", { name: "后端" }));
      fireEvent.change(screen.getByRole("combobox", { name: "状态" }), { target: { value: "todo" } });
      fireEvent.click(sectionTabs().getByRole("tab", { name: "概览" }));
      fireEvent.click(within(document.getElementById("project-overview-progress")!).getByRole("button", { name: /已完成根.*前往任务列表/ }));
      await waitFor(() => expect(listButton("已完成根")).toHaveFocus());
      expect(screen.getByRole("button", { name: "移除 后端" })).toBeVisible();
      expect(screen.getByRole("combobox", { name: "状态" })).toHaveValue("todo");

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
    fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
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
    fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
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
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
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
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
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
      fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
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
    fireEvent.click(screen.getByText("标签筛选", { selector: "summary" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "已删除" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "保留" }));
    const input = searchForm().getByRole("textbox", { name: "搜索任务 ID、标题和描述" });
    fireEvent.change(input, { target: { value: "query" } }); fireEvent.submit(input.closest("form")!);
    await screen.findByText("选中的标签已不可用，请移除后重新查询。");
    await waitFor(() => expect(screen.getByText(/已不可用/, { selector: ".tag-filter-chip" })).toHaveTextContent("已删除"));
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
    const ordinaryStatus = screen.getByLabelText("状态");
    fireEvent.change(ordinaryStatus, { target: { value: "todo" } });
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
    expect(screen.getByLabelText("状态")).toHaveValue("todo");
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

  it("routes session shortcuts directly to the selected task session tab", async () => {
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />); selectTasks();
    fireEvent.click(await findListButton(`进入会话 ${A}`));
    expect(window.location.pathname).toBe(`/projects/${projectId}/tasks/${A}`);
    expect(window.location.search).toBe('?tab=session');
    expect(screen.queryByLabelText('详情测试外壳')).toBeNull();
  });

  beforeEach(() => { window.localStorage.setItem(`daynight:completed-chains:${projectId}`, "true"); });
  beforeEach(() => { rememberRoot(A); });

  it("loads a complete graph into six accurate unique-task statistics and opens a chain only on request", async () => {
    window.localStorage.clear();
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(pending.promise);
    render(<ProjectPage projectId={projectId} />); selectTasks();
    expect(screen.getByRole("status", { name: "正在加载任务图" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "项目任务统计" })).toBeNull();
    await act(async () => { pending.resolve(graph()); });
    expect(await screen.findByRole("heading", { name: "核心项目" })).toBeTruthy(); await waitForGraph();
    expect(["任务总数", "已完成", "待处理", "进行中", "可开始", "被阻塞"].map(number)).toEqual(["4", "1", "3", "0", "2", "1"]);
    expect(screen.getByText("完成比例 25%")).toBeTruthy();
    expect(screen.getAllByText("待处理的子集")).toHaveLength(2);
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
    expect(["任务总数", "已完成", "待处理", "进行中", "可开始", "被阻塞"].map(number)).toEqual(["0", "0", "0", "0", "0", "0"]);
    expect(screen.getByText("完成比例 0%")).toBeTruthy();
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
