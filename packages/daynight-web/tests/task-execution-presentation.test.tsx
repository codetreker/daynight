import { summariesForIndex } from "./helpers/taskSync";

// This timing fixture uses descriptive graph IDs; real links are covered by browser tests.
vi.mock('../src/app/router', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/app/router')>(),
  taskDetailUrl: (projectId: string, taskId: string) => `/projects/${projectId}/tasks/${taskId}`,
}));
import { summariesForGraph } from './helpers/taskSync';
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphTask, TaskGraph as TaskGraphData } from "../src/api/types";
import { StandaloneList } from "../src/features/projects/StandaloneList";
import { StandaloneTaskRow } from "../src/features/projects/StandaloneTaskRow";
import { TaskPauseProvider } from "../src/features/task-pause/TaskPause";
import type { GraphSnapshot } from "../src/features/projects/useTaskGraph";
import { TaskExecutionClockProvider } from "../src/features/task-execution/TaskExecutionClock";
import { TaskGraph } from "../src/features/task-graph/TaskGraph";
import { buildGraphIndex } from "../src/features/task-graph/model";
import * as layoutModule from "../src/features/task-graph/layout";
import { LanguageSelector } from "../src/i18n/LanguageSelector";
import type { Locale } from "../src/i18n/locale";
import { installGraphMeasurements } from "./graph-measurements";
import { renderWithLocale } from "./helpers/renderWithLocale";

const start = "2026-10-20T00:00:00.123456789Z";
const task = (id: string, changes: Partial<GraphTask> = {}): GraphTask => ({ type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [],
  id, titlePreview: id, titleTruncated: false, status: "done", dependsOn: [], blockedBy: [], ready: false,
  startedAt: null, completedAt: null, cancelledAt: null, createdAt: start, updatedAt: start, ...changes,
});
const graph: TaskGraphData = {
  observedAt: "2026-10-20T00:59:59.123Z",
  project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: "project", name: "Project", repoUrl: "https://github.com/example/repo", createdAt: start, updatedAt: start,
    settings: { version: 1n, executionWarningMinutes: 60 } },
  summary: { proposed: 0, total: 3, todo: 0, inProgress: 1, done: 2, cancelled: 0, ready: 0, blocked: 0 },
  tasks: [task("A"), task("B"), task("C", { titlePreview: "A deliberately long shared task title preserving the existing card controls", titleTruncated: true,
    status: "in_progress", allowAgents: true, startedAt: start, dependsOn: ["A", "B"] })],
};
const index = buildGraphIndex(graph);
const snapshot = (elapsedMilliseconds: number, warningMinutes = 60): GraphSnapshot => ({
  graph: { ...graph, project: { ...graph.project, settings: { version: 1n, executionWarningMinutes: warningMinutes } } },
  index, summaries: summariesForGraph(graph), workerMachines: new Map(), pausedTaskIds: new Set<string>(), observedAt: new Date(Date.parse(start) + elapsedMilliseconds).toISOString(), receivedAt: 0, receivedMonotonic: 0, revision: 1,
});
const noop = () => {};
const canvas = (value: GraphSnapshot) => <TaskExecutionClockProvider projectId="project" snapshot={value}>
  <LanguageSelector /><TaskGraph index={index} rootId="A" onOpenTask={noop} />
</TaskExecutionClockProvider>;
const viewport = (container: HTMLElement) => container.querySelector<HTMLElement>(".react-flow__viewport")!;

beforeEach(() => {
  installGraphMeasurements();
  vi.spyOn(performance, "now").mockReturnValue(0);
});

describe("task execution presentation", () => {
  it.each(["en", "zh-CN"] as const)("updates the strict warning boundary and geometry without replacing graph controls in %s", async (locale) => {
    const layout = vi.spyOn(layoutModule, "layoutGraph");
    const view = renderWithLocale(canvas(snapshot(3_599_000)), { locale, taskCache: true });
    await waitFor(() => expect(view.container.querySelectorAll(".react-flow__edge-path")).toHaveLength(2));
    await waitFor(() => expect(viewport(view.container).style.transform).not.toBe("translate(0px,0px) scale(1)"));
    const card = view.container.querySelector<HTMLElement>(".task-node-in_progress")!;
    const body = card.querySelector<HTMLButtonElement>(".task-node-body")!;
    const details = card.querySelector<HTMLButtonElement>(".task-node-details")!;
    const name = body.getAttribute("aria-label");
    fireEvent.click(body);
    details.focus();
    const nodes = [...view.container.querySelectorAll<HTMLElement>(".react-flow__node")];
    const positions = nodes.map((node) => node.style.transform);
    const edges = [...view.container.querySelectorAll(".react-flow__edge-path")];
    const routes = edges.map((edge) => edge.getAttribute("d"));
    const transform = viewport(view.container).style.transform;
    expect(card.querySelector(".task-duration")).toHaveAttribute("datetime", "PT3599.000S");
    expect(card.querySelector(".task-duration")).toHaveTextContent(locale === "en" ? "59min" : "59 分钟");
    expect(card).not.toHaveClass("task-node-stuck");
    view.rerender(canvas(snapshot(3_600_000)));
    expect(card).not.toHaveClass("task-node-stuck");
    expect(card.querySelector(".task-duration")).toHaveAttribute("datetime", "PT3600.000S");
    view.rerender(canvas(snapshot(3_601_000)));
    expect(card).toHaveClass("task-node-stuck", "task-node-selected");
    expect(card.closest<HTMLElement>(".react-flow__node")!.style.height).toBe("124px");
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(details).toHaveFocus();
    expect(card.querySelector(".task-stuck-label")).toHaveTextContent(locale === "en" ? "Possibly stuck" : "可能卡住了");
    expect(card.querySelector(".task-stuck-label svg")).toHaveAttribute("aria-hidden", "true");
    expect(card.querySelector(".task-shared-label")).toBeNull();
    expect(card.querySelector(".graph-status")).toHaveClass("graph-status-in_progress");
    expect(body.getAttribute("aria-label")).toBe(`${name}${locale === "en" ? ", selected" : "，已选中"}`);
    expect(body).toHaveAccessibleDescription(new RegExp(start.replaceAll(".", "\\.")));
    expect(body).toHaveAccessibleDescription(/60/);
    expect(details).toHaveFocus();
    view.rerender(canvas(snapshot(3_601_000, 61)));
    expect(card).not.toHaveClass("task-node-stuck");
    expect(body).toHaveAccessibleDescription(/61/);
    expect(card.querySelector(".task-node-body")).toBe(body);
    expect(card.querySelector(".task-node-details")).toBe(details);
    expect([...view.container.querySelectorAll(".react-flow__node")]).toEqual(nodes);
    expect(nodes.map((node) => node.style.transform)).toEqual(positions);
    expect([...view.container.querySelectorAll(".react-flow__edge-path")]).toEqual(edges);
    expect(edges.map((edge) => edge.getAttribute("d"))).toEqual(routes);
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(layout).toHaveBeenCalledTimes(3);
    for (const node of nodes) {
      expect(node.style.width).toBe("240px");
      expect(node.style.height).toBe("102px");
    }
    expect(card.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it.each(["en", "zh-CN"] as const)("advances only a running standalone row and freezes completed duration with exact source timestamps in %s", (locale) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let monotonic = 0;
    vi.mocked(performance.now).mockImplementation(() => monotonic);
    const end = "2026-10-22T03:04:00.123456789Z";
    const rows = [task("running", { status: "in_progress", allowAgents: true, startedAt: start }),
      task("completed", { startedAt: start, completedAt: end }), task("unknown", { status: "in_progress" })];
    const rowGraph = { ...graph, tasks: rows, summary: { ...graph.summary, inProgress: 2, done: 1 } };
    const rowIndex = buildGraphIndex(rowGraph);
    const ids = rows.map(({ id }) => id);
    const view = renderWithLocale(<TaskExecutionClockProvider projectId="project" snapshot={{ ...snapshot(30_000), graph: rowGraph, index: rowIndex }}>
      <StandaloneList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={rowIndex} summaries={summariesForIndex(rowIndex)} taskIds={ids} allTaskIds={ids} onSelectTask={noop} />
    </TaskExecutionClockProvider>, { locale, taskCache: true });
    const running = document.getElementById("standalone-task-running")!;
    const completed = document.getElementById("standalone-task-completed")!;
    const unknown = document.getElementById("standalone-task-unknown")!;
    const runningRow = running.closest('.task-row')!, completedRow = completed.closest('.task-row')!, unknownRow = unknown.closest('.task-row')!;
    const completedTime = completedRow.querySelector('.task-duration')!;
    expect(runningRow).toHaveAttribute('data-task-status', 'in_progress');
    expect(completedRow).toHaveAttribute('data-task-status', 'done');
    for (const row of [runningRow, completedRow]) {
      expect(row.querySelector('.task-row-meta .task-duration')).not.toBeNull();
      expect(row.querySelector('.task-assignee-identity')).not.toBeNull();
    }
    expect(runningRow.querySelector('.task-duration')).toHaveTextContent(locale === 'en' ? '< 1 min' : '不足 1 分钟');
    expect(completedTime).toHaveTextContent(locale === 'en' ? '2d 3h 4min' : '2 天 3 小时 4 分钟');
    expect(completedTime).toHaveAttribute('datetime', 'PT183840.000S');
    expect(completed).toHaveAccessibleDescription(new RegExp(end.replaceAll('.', '\\.')));
    expect(unknownRow.querySelector('.task-duration, .task-stuck-label')).toBeNull();
    expect(unknownRow).toHaveTextContent(locale === 'en' ? 'Duration unknown' : '耗时未知');
    expect(running).toHaveAccessibleName('running');
    running.focus();
    monotonic = 3_600_000;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(runningRow.querySelector('.task-duration')).toHaveAttribute('datetime', 'PT3630.000S');
    expect(runningRow).toHaveClass('standalone-row-stuck');
    expect(running).toHaveAccessibleName('running');
    expect(running).toHaveAccessibleDescription(new RegExp(locale === 'en' ? 'Possibly stuck' : '可能卡住了'));
    expect(completedRow.querySelector('.task-duration')).toBe(completedTime);
    expect(completedTime).toHaveAttribute('datetime', 'PT183840.000S');
    expect(completedRow).not.toHaveClass('standalone-row-stuck');
    expect(running).toHaveFocus();
    expect(view.container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it("keeps repeated standalone task instances independently addressable", () => {
    const item = task("repeated", { status: "in_progress", allowAgents: true, startedAt: start });
    const rowGraph = { ...graph, tasks: [item], summary: { ...graph.summary, total: 1, inProgress: 1, done: 0 } };
    const rowIndex = buildGraphIndex(rowGraph);
    const select = vi.fn();
    renderWithLocale(<TaskExecutionClockProvider projectId="project" snapshot={{ ...snapshot(30_000), graph: rowGraph, index: rowIndex }}>
      <TaskPauseProvider taskIds={new Set([item.id])}><ul className="standalone-list">
        <StandaloneTaskRow title={item.titlePreview} projectId="00000000-0000-4000-8000-000000000101" task={item} instanceId="goal-one-task-repeated" onSelectTask={select} />
        <StandaloneTaskRow title={item.titlePreview} projectId="00000000-0000-4000-8000-000000000101" task={item} instanceId="goal-two-task-repeated" onSelectTask={select} />
      </ul></TaskPauseProvider>
    </TaskExecutionClockProvider>, { locale: "en", taskCache: true });
    const first = document.getElementById("goal-one-task-repeated")!;
    const second = document.getElementById("goal-two-task-repeated")!;
    for (const row of [first, second]) {
      const description = row.getAttribute("aria-describedby")!;
      expect(description).toBeTruthy();
      expect(document.getElementById(description)).toHaveTextContent(start);
      expect(row).toHaveAccessibleDescription(new RegExp(start.replaceAll(".", "\\.")));
      expect(row.closest(".task-row")).toHaveTextContent("Blocked");
      fireEvent.click(row);
    }
    expect(select.mock.calls).toEqual([[item.id, first], [item.id, second]]);
    expect(first.getAttribute("aria-describedby")).not.toBe(second.getAttribute("aria-describedby"));
  });

  it.each(["en", "zh-CN"] as const)("keeps overdue tasks without Agent permission timed and free of warnings in %s", async (locale) => {
    const manualGraph = { ...graph, tasks: graph.tasks.map((task) => ({ ...task, allowAgents: false })) };
    const manualIndex = buildGraphIndex(manualGraph);
    const content = (elapsed: number) => <TaskExecutionClockProvider projectId="project" snapshot={{ ...snapshot(elapsed), graph: manualGraph, index: manualIndex }}>
      <TaskGraph index={manualIndex} rootId="A" onOpenTask={noop} />
      <StandaloneList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={manualIndex} summaries={summariesForIndex(manualIndex)} taskIds={["C"]} allTaskIds={["C"]} onSelectTask={noop} />
    </TaskExecutionClockProvider>;
    const view = renderWithLocale(content(3_601_000), { locale, taskCache: true });
    await waitFor(() => expect(view.container.querySelector(".task-node-in_progress")).not.toBeNull());
    const card = view.container.querySelector<HTMLElement>(".task-node-in_progress")!;
    const row = document.getElementById("standalone-task-C")!;
    for (const elapsed of [3_601_000, 7_201_000]) {
      view.rerender(content(elapsed));
      for (const element of [card, row.closest(".task-row")!]) {
        expect(element.querySelector(".task-duration")).toHaveAttribute("datetime", `PT${(elapsed / 1000).toFixed(3)}S`);
        expect(element).not.toHaveClass("task-node-stuck");
        expect(element).not.toHaveClass("standalone-row-stuck");
        expect(element.querySelector(".task-stuck-label")).toBeNull();
      }
      for (const button of [card.querySelector(".task-node-body")!, row]) {
        expect(button).toHaveAccessibleDescription(/60/);
        expect(button).not.toHaveAccessibleDescription(/Possibly stuck|可能卡住了/);
      }
    }
  });

  it.each(["en", "zh-CN"] as const)("omits unknown completed and running execution without requiring a fabricated clock in %s", (locale: Locale) => {
    const unknownIndex = buildGraphIndex({ ...graph, tasks: [task("unknown-running", { status: "in_progress" }), task("unknown-done", { completedAt: start })],
      summary: { ...graph.summary, total: 2, inProgress: 1, done: 1 } });
    const ids = ["unknown-running", "unknown-done"];
    const view = renderWithLocale(<TaskExecutionClockProvider projectId="project" snapshot={null}><StandaloneList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={unknownIndex} summaries={summariesForIndex(unknownIndex)} taskIds={ids} allTaskIds={ids} onSelectTask={noop} /></TaskExecutionClockProvider>, { locale, taskCache: true });
    expect(view.container.querySelector(".task-duration, .task-stuck-label")).toBeNull();
  });
});
