import { createGraphSyncFixture } from "./helpers/taskSync";
import { useEffect } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getTask, getTaskSync } from "../src/api/client";
import type { GraphTask, TaskDetail, TaskGraph, TaskStatus } from "../src/api/types";
import { ProjectPage } from "../src/features/projects/ProjectPage";
import type { GraphSnapshot } from "../src/features/projects/useTaskGraph";
import { useTaskDetail } from "../src/features/task-detail/useTaskDetail";
import { projectChain, type GraphIndex } from "../src/features/task-graph/model";

const localeRender = createLocaleRender("zh-CN");
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock("../src/api/client", async (original) => ({ ...await original<typeof import("../src/api/client")>(), getTask: vi.fn(), getTaskSync: vi.fn() }));
vi.mock("../src/features/task-graph/ChainList", () => ({ ChainList: ({ index, representativeIds, expandedRootId, onExpand, onOpenTask }: {
  index: GraphIndex; representativeIds: readonly string[]; expandedRootId: string | null; onExpand: (id: string | null) => void; onOpenTask: (id: string, trigger: HTMLElement) => void;
}) => <div data-testid="root-list" data-index-roots={index.representativeIds.join(",")}>{representativeIds.map((root) => <div key={root}>
  <button id={`task-root-${root}`} onClick={() => onExpand(expandedRootId === root ? null : root)}>{index.nodes.get(root)!.titlePreview}</button>
  {expandedRootId === root && <div data-testid={`chain-${root}`}>{[...projectChain(index, root).mainIds].map((id) => <button key={id} onClick={(event) => onOpenTask(id, event.currentTarget)}>节点 {index.nodes.get(id)!.titlePreview}</button>)}</div>}
</div>)}</div> }));
vi.mock("../src/features/task-detail/TaskDetailDialog", () => ({ TaskDetailDialog: ({ projectId, taskId, snapshot, onSelectTask, onClose, onRestoreFocus, onRefreshGraph }: {
  projectId: string; taskId: string; snapshot: GraphSnapshot; onSelectTask: (id: string) => void; onClose: () => void; onRestoreFocus: () => void; onRefreshGraph: () => void;
}) => {
  const state = useTaskDetail(projectId, taskId, snapshot.revision, snapshot.index.nodes.get(taskId));
  useEffect(() => () => onRestoreFocus(), [onRestoreFocus]);
  return <aside aria-label="详情测试外壳"><p data-testid="selected-task">{taskId}</p><p data-testid="detail-state">{state.status}</p><p data-testid="detail-title">{state.detail?.title}</p><p data-testid="detail-business-status">{state.detail?.status}</p>
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
    return { requiredPlatform: null, allowAgents: false, externalDependsOn: seed.externalDependsOn ?? [], startedAt: null, completedAt: null, id: seed.id, titlePreview: seed.title, titleTruncated: false, status: seed.status, dependsOn: seed.dependsOn, blockedBy,
      ready: seed.status === "todo" && blockedBy.length === 0, createdAt: time, updatedAt: time };
  });
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { settings: { version: 1n, executionWarningMinutes: 60 }, id, name: id === projectId ? "核心项目" : "另一个项目", repoUrl: "git@github.com:example/project.git", createdAt: time, updatedAt: time }, tasks,
    summary: { total: tasks.length, todo: tasks.filter((task) => task.status === "todo").length,
      done: tasks.filter((task) => task.status === "done").length, inProgress: tasks.filter((task) => task.status === "in_progress").length,
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
const number = (label: string) => screen.getByText(label, { selector: ".stat-label" }).parentElement?.querySelector(".stat-number")?.textContent;
const preferenceKey = (id = projectId) => `daynight:project-view:${id}`;
const rememberRoot = (root: string | null, id = projectId) => window.localStorage.setItem(preferenceKey(id), JSON.stringify({ expandedRootId: root }));

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture();
const servedGraphs = new Map<string, TaskGraph>();
const servedVersions = new Map<string, bigint>();
beforeEach(() => {
  syncFixture.reset();
  servedGraphs.clear(); servedVersions.clear();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    const sync = syncFixture.toSync(value, query, replacementEpochs.get(value));
    servedGraphs.set(projectId, value);
    for (const task of sync.tasks) servedVersions.set(`${projectId}/${task.id}`, task.version);
    return sync;
  });
});

beforeEach(() => {
  graphRequest.mockReset(); detailRequest.mockReset();
  detailRequest.mockImplementation(async (project, id): Promise<TaskDetail> => {
    const task = servedGraphs.get(project)!.tasks.find((item) => item.id === id);
    if (id === X) return { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null,
      id, projectId: project, title: 'New task', description: '文本', properties: { worker: null, pullRequests: [] }, status: 'todo', version: 1n, dependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time };
    return { ...task!, id, projectId: project, title: task!.titlePreview, description: '文本', properties: { worker: null, pullRequests: [] }, version: servedVersions.get(`${project}/${id}`)! };
  });
});

describe("project dashboard", () => {
  beforeEach(() => { window.localStorage.setItem(`daynight:completed-chains:${projectId}`, "true"); });
  beforeEach(() => { rememberRoot(A); });

  it("loads a complete graph into six accurate unique-task statistics and expands the newest root on a first visit", async () => {
    window.localStorage.clear();
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(pending.promise);
    render(<ProjectPage projectId={projectId} />);
    expect(screen.getByRole("status", { name: "正在加载任务图" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "项目任务统计" })).toBeNull();
    await act(async () => { pending.resolve(graph()); });
    expect(await screen.findByRole("heading", { name: "核心项目" })).toBeTruthy();
    expect(["任务总数", "已完成", "待处理", "进行中", "可开始", "被阻塞"].map(number)).toEqual(["4", "1", "3", "0", "2", "1"]);
    expect(screen.getByText("完成比例 25%")).toBeTruthy();
    expect(screen.getAllByText("待处理的子集")).toHaveLength(2);
    expect(screen.getByTestId(`chain-${C}`)).toBeTruthy();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
    expect(screen.getByText("git@github.com:example/project.git")).toBeTruthy();
    expect(screen.getByText(/最近成功刷新/).closest("time")?.getAttribute("datetime")).not.toBe(time);
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    expect(screen.getByTestId(`chain-${A}`)).toBeTruthy();
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it("retains the snapshot and receipt time on refresh failure and keeps a valid expanded root", async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "核心项目" });
    fireEvent.click(screen.getByRole("button", { name: "另一任务链" }));
    const receipt = screen.getByText(/最近成功刷新/).closest("time")?.getAttribute("datetime");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(screen.getByRole("button", { name: "正在刷新…" })).toBeDisabled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(number("任务总数")).toBe("4");
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    await act(async () => { pending.reject(new ApiError("server", 500, "internal_error", "refresh-request")); });
    expect((await screen.findByRole("alert")).textContent).toContain("仍显示上次成功读取的数据");
    expect(screen.getByText("refresh-request")).toBeTruthy();
    expect(screen.getByText(/最近成功刷新/).closest("time")?.getAttribute("datetime")).toBe(receipt);
    expect(screen.getByTestId(`chain-${C}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试刷新" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByTestId(`chain-${C}`)).toBeTruthy();
  });

  it("selects the new first root after refresh removes the expanded root and closes a vanished detail with focus fallback", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([seeds[2]!, seeds[3]!])));
    render(<ProjectPage projectId={projectId} />);
    const trigger = await screen.findByRole("button", { name: "节点 后续任务" });
    trigger.focus(); fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    fireEvent.click(screen.getByRole("button", { name: "刷新全图" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(await screen.findByText("所选任务已不在新的任务图中，详情已关闭。")).toBeTruthy();
    expect(screen.getByTestId(`chain-${C}`)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "另一任务链" }));
    expect(number("任务总数")).toBe("2");
  });

  it("reuses a retained detail after an unchanged graph receipt without patching graph statistics", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />);
    fireEvent.click(await screen.findByRole("button", { name: "节点 后续任务" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    expect(detailRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("detail-business-status").textContent).toBe("todo");
    expect(number("已完成")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "刷新全图" }));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    expect(detailRequest).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected-task").textContent).toBe(B);
    expect(number("已完成")).toBe("1");
  });

  it("preserves the original node focus across relation navigation and allows unknown snapshot references", async () => {
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />);
    const trigger = await screen.findByRole("button", { name: "节点 后续任务" });
    trigger.focus(); fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    fireEvent.click(screen.getByRole("button", { name: "关系跳转" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("另一任务链"));
    expect(screen.getByTestId("selected-task").textContent).toBe(C);
    fireEvent.click(screen.getByRole("button", { name: "未知关系" }));
    await waitFor(() => expect(detailRequest.mock.calls.at(-1)?.[1]).toBe(X));
    expect(screen.getByTestId("detail-title")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("falls back to the page heading when the selected chain disappears into an empty snapshot", async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([])));
    render(<ProjectPage projectId={projectId} />);
    fireEvent.click(await screen.findByRole("button", { name: "节点 后续任务" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("后续任务"));
    fireEvent.click(screen.getByRole("button", { name: "刷新全图" }));
    await screen.findByRole("heading", { name: "还没有任务" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "核心项目" })));
    expect(number("任务总数")).toBe("0");
    expect(screen.queryByTestId("root-list")).toBeNull();
  });

  it("clears project-specific display immediately when the project prop changes", async () => {
    const pending = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(pending.promise);
    const view = render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "核心项目" });
    view.rerender(<ProjectPage projectId={otherProject} />);
    expect(screen.queryByRole("heading", { name: "核心项目" })).toBeNull();
    expect(screen.queryByRole("region", { name: "项目任务统计" })).toBeNull();
    await act(async () => { pending.resolve(graph(seeds, otherProject)); });
    expect(await screen.findByRole("heading", { name: "另一个项目" })).toBeTruthy();
  });

  it("renders an empty project as zero statistics and an explicit empty state", async () => {
    graphRequest.mockResolvedValue(graph([]));
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "还没有任务" });
    expect(["任务总数", "已完成", "待处理", "进行中", "可开始", "被阻塞"].map(number)).toEqual(["0", "0", "0", "0", "0", "0"]);
    expect(screen.getByText("完成比例 0%")).toBeTruthy();
  });

  it.each([
    [new ApiError("server", 404, "not_found", "missing-project"), "项目不存在", "这个项目不存在，请返回项目列表。"],
    [new ApiError("network"), "项目加载失败", "无法连接服务，请检查本地服务后重试。"],
    [new ApiError("protocol", 200), "任务图数据不完整", "任务图数据不完整或不一致，请重试。"],
  ] as const)("shows safe first-load errors without zero-stat fallbacks %#", async (failure, heading, message) => {
    graphRequest.mockRejectedValueOnce(failure).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />);
    expect((await screen.findByRole("alert")).textContent).toContain(heading);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText("任务总数")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "核心项目" });
  });

  it("explains graph limits using actual counts and rejects malformed graph snapshots", async () => {
    graphRequest.mockRejectedValueOnce(new ApiError("server", 409, "graph_limit_exceeded", "large-graph", { nodeCount: 1001, edgeCount: 5100, maxNodes: 1000, maxEdges: 5000 }))
      .mockResolvedValueOnce({ ...graph(), tasks: graph().tasks.map((task) => task.id === B ? { ...task, dependsOn: [X] } : task) });
    render(<ProjectPage projectId={projectId} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "任务图超过展示上限" })).toBeTruthy();
    expect(alert.textContent).toContain("当前 1,001 个任务、5,100 条依赖；支持最多 1,000 个任务、5,000 条依赖。");
    expect(alert.textContent).toContain("large-graph");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("heading", { name: "任务图数据不完整" });
    expect(screen.queryByText("任务总数")).toBeNull();
  });

  it("renders untrusted project values as plain text and preserves modified return clicks", async () => {
    graphRequest.mockResolvedValue({ ...graph([]), project: { ...graph().project, name: "<img src=x onerror=alert(1)>", repoUrl: "javascript:alert(1)" } });
    const view = render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "<img src=x onerror=alert(1)>" });
    expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "← 项目" });
    const observe = (event: Event) => { expect(event.defaultPrevented).toBe(false); event.preventDefault(); };
    document.addEventListener("click", observe, { once: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/");
  });
});

describe("newest-first task chains", () => {
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
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${F}`)).toBeVisible();
    expect(presentedRoots()).toEqual([F, E, A].map((id) => `task-root-${id}`));
    expect(screen.getByTestId("root-list")).toHaveAttribute("data-index-roots", [A, E, F].join(","));
    expect(snapshot.tasks.map((task) => task.id)).toEqual([A, B, C, D, E, F, X, Y]);
    fireEvent.click(screen.getByRole("button", { name: "最早任务链" }));
    const chain = screen.getByTestId(`chain-${A}`);
    expect(within(chain).getAllByRole("button").map((button) => button.textContent)).toEqual(["节点 最早任务链", "节点 已完成后续", "节点 稍早任务链", "节点 最新后续任务"]);
    expect(number("任务总数")).toBe("8");
    expect(number("已完成")).toBe("3");
  });

  it("keeps a remembered older root open when newer roots arrive and selects the newest fallback when it disappears", async () => {
    rememberRoot(A);
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([...seeds, ...newerRoots]))
      .mockResolvedValueOnce(resetSnapshot(graph([seeds[2]!, seeds[3]!, ...newerRoots])));
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("button", { name: "最新任务链" });
    expect(presentedRoots()).toEqual([F, E, C, A].map((id) => `task-root-${id}`));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${F}`)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: A });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${F}`)).toBeVisible();
    expect(presentedRoots()).toEqual([F, E, C].map((id) => `task-root-${id}`));
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: F });
  });

  it("keeps an explicitly collapsed list closed when newer roots arrive", async () => {
    rememberRoot(null);
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([...seeds, ...newerRoots]));
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("button", { name: "另一任务链" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("button", { name: "最新任务链" });
    expect(presentedRoots()).toEqual([F, E, C, A].map((id) => `task-root-${id}`));
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: null });
  });
});

describe("component witness preferences", () => {
  const saved = () => JSON.parse(window.localStorage.getItem(preferenceKey())!);
  const joined = () => graph(seeds.map((task) => task.id === C ? { ...task, dependsOn: [A] } : task));

  it("retains the saved member through a component merge, reload and split", async () => {
    rememberRoot(D);
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(joined())
      .mockResolvedValueOnce(joined()).mockResolvedValueOnce(graph());
    let view = render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    expect(saved()).toEqual({ expandedRootId: D });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    expect(saved()).toEqual({ expandedRootId: D });
    view.unmount();
    view = render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(saved()).toEqual({ expandedRootId: D });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
    expect(saved()).toEqual({ expandedRootId: D });
  });

  it("retains an explicit collapse through a component merge, reload and split", async () => {
    rememberRoot(null);
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(joined())
      .mockResolvedValueOnce(joined()).mockResolvedValueOnce(graph());
    let view = render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("button", { name: "另一任务链" });
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "另一任务链" })).toBeNull());
    expect(saved()).toEqual({ expandedRootId: null });
    view.unmount();
    view = render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("button", { name: "已完成根" });
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("button", { name: "另一任务链" });
    expect(screen.queryAllByTestId(/^chain-/)).toHaveLength(0);
    expect(saved()).toEqual({ expandedRootId: null });
  });
});

describe("remembered task chain expansion", () => {
  beforeEach(() => { window.localStorage.setItem(`daynight:completed-chains:${projectId}`, "true"); });
  it("restores a chosen root and an explicitly collapsed list after remounting", async () => {
    graphRequest.mockResolvedValue(graph());
    let view = render(<ProjectPage projectId={projectId} />);
    fireEvent.click(await screen.findByRole("button", { name: "已完成根" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    view.unmount();
    view = render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    view.unmount();
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("button", { name: "已完成根" });
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: null });
  });

  it("keeps project preferences separate across navigation", async () => {
    graphRequest.mockImplementation(async (id) => graph(seeds, id));
    const view = render(<ProjectPage projectId={projectId} />);
    fireEvent.click(await screen.findByRole("button", { name: "已完成根" }));
    view.rerender(<ProjectPage projectId={otherProject} />);
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "另一任务链" }));
    view.rerender(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    view.rerender(<ProjectPage projectId={otherProject} />);
    await screen.findByRole("button", { name: "另一任务链" });
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it("reads once per mounted project and preserves saved state during loading and refresh failure", async () => {
    rememberRoot(A);
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new ApiError("network"));
    render(<ProjectPage projectId={projectId} />);
    expect(read.mock.calls.filter(([key]) => key === preferenceKey())).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(graph()); });
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("alert");
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(read.mock.calls.filter(([key]) => key === preferenceKey())).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not replace saved preferences when an initial graph read fails", async () => {
    rememberRoot(A);
    const write = vi.spyOn(Storage.prototype, "setItem");
    graphRequest.mockRejectedValueOnce(new ApiError("network")).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("alert");
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([X, B])("resolves a retained member or falls back for a missing remembered task after a successful nonempty snapshot (%s)", async (remembered) => {
    rememberRoot(remembered);
    const pending = deferred<TaskGraph>();
    const write = vi.spyOn(Storage.prototype, "setItem");
    graphRequest.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(resetSnapshot(graph([seeds[0]!, seeds[1]!])));
    render(<ProjectPage projectId={projectId} />);
    expect(write).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(graph()); });
    expect(await screen.findByTestId(`chain-${remembered === B ? A : C}`)).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: remembered === B ? B : C });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: remembered === B ? B : A });
  });

  it.each([undefined, A, X])("preserves automatic expansion through empty snapshots and remounts (%s)", async (remembered) => {
    if (remembered !== undefined) rememberRoot(remembered);
    const write = vi.spyOn(Storage.prototype, "setItem");
    graphRequest.mockResolvedValueOnce(resetSnapshot(graph([]))).mockResolvedValueOnce(resetSnapshot(graph([]))).mockResolvedValueOnce(graph());
    const view = render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "还没有任务" });
    expect(write).not.toHaveBeenCalled();
    view.unmount();
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "还没有任务" });
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId(`chain-${remembered === A ? A : C}`)).toBeVisible();
  });

  it("retains an explicit collapse when an empty project later gains roots", async () => {
    rememberRoot(null);
    graphRequest.mockResolvedValueOnce(resetSnapshot(graph([]))).mockResolvedValueOnce(graph());
    render(<ProjectPage projectId={projectId} />);
    await screen.findByRole("heading", { name: "还没有任务" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("button", { name: "已完成根" });
    expect(screen.queryByTestId(`chain-${C}`)).toBeNull();
    expect(screen.queryByTestId(`chain-${A}`)).toBeNull();
  });

  it.each(["{", "null", "[]", "{}", '{"expandedRootId":12}', '{"expandedRootId":"  "}', '{"expandedRootId":null,"unknown":true}'])(
    "reports invalid stored preferences and keeps the list usable (%s)", async (stored) => {
      window.localStorage.setItem(preferenceKey(), stored);
      graphRequest.mockResolvedValue(graph());
      render(<ProjectPage projectId={projectId} />);
      expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent("浏览器保存的任务链展开状态无效");
      fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
      expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
      expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: A });
    },
  );

  it("reports blocked preference reads while keeping expansion and saving usable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked by browser policy", "SecurityError"); });
    const write = vi.spyOn(Storage.prototype, "setItem");
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    expect(screen.getByText(/^无法读取浏览器保存的任务链展开状态/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    expect(write).toHaveBeenLastCalledWith(preferenceKey(), JSON.stringify({ expandedRootId: A }));
  });

  it("reports blocked storage access without preventing browsing", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Storage access denied", "SecurityError"); });
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    await waitFor(() => expect(screen.getByText(/^任务链展开状态无法保存到浏览器/)).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
  });

  it("reports failed saves and clears that notice when a later user choice is saved", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage is full", "QuotaExceededError"); });
    graphRequest.mockResolvedValue(graph());
    render(<ProjectPage projectId={projectId} />);
    expect(await screen.findByTestId(`chain-${C}`)).toBeVisible();
    expect(screen.getByText(/^任务链展开状态无法保存到浏览器/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    expect(await screen.findByTestId(`chain-${A}`)).toBeVisible();
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "已完成根" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(preferenceKey())!)).toEqual({ expandedRootId: null });
  });
});
