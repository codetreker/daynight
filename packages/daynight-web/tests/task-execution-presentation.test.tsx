import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphTask, TaskGraph as TaskGraphData } from "../src/api/types";
import { StandaloneList } from "../src/features/projects/StandaloneList";
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
const task = (id: string, changes: Partial<GraphTask> = {}): GraphTask => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [],
  id, titlePreview: id, titleTruncated: false, status: "done", dependsOn: [], blockedBy: [], ready: false,
  startedAt: null, completedAt: null, createdAt: start, updatedAt: start, ...changes,
});
const graph: TaskGraphData = {
  observedAt: "2026-10-20T00:59:59.123Z",
  project: { id: "project", name: "Project", repoUrl: "https://github.com/example/repo", createdAt: start, updatedAt: start,
    settings: { version: 1n, executionWarningMinutes: 60 } },
  summary: { total: 3, todo: 0, inProgress: 1, done: 2, ready: 0, blocked: 0 },
  tasks: [task("A"), task("B"), task("C", { titlePreview: "A deliberately long shared task title preserving the existing card controls", titleTruncated: true,
    status: "in_progress", allowAgents: true, startedAt: start, dependsOn: ["A", "B"] })],
};
const index = buildGraphIndex(graph);
const snapshot = (elapsedMilliseconds: number, warningMinutes = 60): GraphSnapshot => ({
  graph: { ...graph, project: { ...graph.project, settings: { version: 1n, executionWarningMinutes: warningMinutes } } },
  index, observedAt: new Date(Date.parse(start) + elapsedMilliseconds).toISOString(), receivedAt: 0, receivedMonotonic: 0, revision: 1,
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
  it.each(["en", "zh-CN"] as const)("updates the strict warning boundary without replacing graph controls or layout in %s", async (locale) => {
    const layout = vi.spyOn(layoutModule, "layoutGraph");
    const view = renderWithLocale(canvas(snapshot(3_599_000)), { locale });
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
    expect(layout).toHaveBeenCalledTimes(1);
    for (const node of nodes) {
      expect(node.style.width).toBe("220px");
      expect(node.style.height).toBe("96px");
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
      <StandaloneList index={rowIndex} taskIds={ids} allTaskIds={ids} onSelectTask={noop} showCompleted onShowCompletedChange={noop} />
    </TaskExecutionClockProvider>, { locale });
    const running = document.getElementById("standalone-task-running")!;
    const completed = document.getElementById("standalone-task-completed")!;
    const unknown = document.getElementById("standalone-task-unknown")!;
    const completedTime = completed.querySelector(".task-duration")!;
    expect(running.querySelector(".task-duration")).toHaveTextContent(locale === "en" ? "< 1 min" : "不足 1 分钟");
    expect(completedTime).toHaveTextContent(locale === "en" ? "2d 3h 4min" : "2 天 3 小时 4 分钟");
    expect(completedTime).toHaveAttribute("datetime", "PT183840.000S");
    expect(completed).toHaveAccessibleDescription(new RegExp(end.replaceAll(".", "\\.")));
    expect(unknown.querySelector(".task-duration, .task-stuck-label")).toBeNull();
    expect(unknown).not.toHaveAttribute("aria-describedby");
    const runningName = running.textContent!.replace(/< 1 min|不足 1 分钟/, "");
    expect(running).toHaveAccessibleName(runningName);
    running.focus();
    monotonic = 3_600_000;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(running.querySelector(".task-duration")).toHaveAttribute("datetime", "PT3630.000S");
    expect(running).toHaveClass("standalone-row-stuck");
    expect(running).toHaveAccessibleName(runningName);
    expect(running).toHaveAccessibleDescription(new RegExp(locale === "en" ? "Possibly stuck" : "可能卡住了"));
    expect(completed.querySelector(".task-duration")).toBe(completedTime);
    expect(completedTime).toHaveAttribute("datetime", "PT183840.000S");
    expect(completed).not.toHaveClass("standalone-row-stuck");
    expect(running).toHaveFocus();
    expect(view.container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it.each(["en", "zh-CN"] as const)("keeps overdue tasks without Agent permission timed and free of warnings in %s", async (locale) => {
    const manualGraph = { ...graph, tasks: graph.tasks.map((task) => ({ ...task, allowAgents: false })) };
    const manualIndex = buildGraphIndex(manualGraph);
    const content = (elapsed: number) => <TaskExecutionClockProvider projectId="project" snapshot={{ ...snapshot(elapsed), graph: manualGraph, index: manualIndex }}>
      <TaskGraph index={manualIndex} rootId="A" onOpenTask={noop} />
      <StandaloneList index={manualIndex} taskIds={["C"]} allTaskIds={["C"]} onSelectTask={noop} showCompleted onShowCompletedChange={noop} />
    </TaskExecutionClockProvider>;
    const view = renderWithLocale(content(3_601_000), { locale });
    await waitFor(() => expect(view.container.querySelector(".task-node-in_progress")).not.toBeNull());
    const card = view.container.querySelector<HTMLElement>(".task-node-in_progress")!;
    const row = document.getElementById("standalone-task-C")!;
    for (const elapsed of [3_601_000, 7_201_000]) {
      view.rerender(content(elapsed));
      for (const element of [card, row]) {
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
    const view = renderWithLocale(<StandaloneList index={unknownIndex} taskIds={ids} allTaskIds={ids} onSelectTask={noop} showCompleted onShowCompletedChange={noop} />, { locale });
    expect(view.container.querySelector(".task-duration, .task-stuck-label")).toBeNull();
  });
});
