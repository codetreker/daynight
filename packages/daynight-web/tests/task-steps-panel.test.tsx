import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { StepsResource, TaskStep } from "../src/api/task-steps";
import { TaskStepsPanel } from "../src/features/task-detail/steps/TaskStepsPanel";
import { renderWithLocale } from "./helpers/renderWithLocale";

const read = vi.hoisted(() => ({ resource: null as StepsResource | null, status: "loading", error: null as unknown, refreshing: false, stale: true, retry: vi.fn() }));
vi.mock("../src/features/task-detail/useTaskSteps", () => ({ useTaskSteps: () => read }));
const projectId = "10000000-0000-0000-0000-000000000001";
const taskId = "20000000-0000-0000-0000-000000000002";
const time = "2026-11-03T12:34:56.123456Z";
const steps: TaskStep[] = Array.from({ length: 241 }, (_, index) => ({ id: index.toString(16).padStart(8, "0"), title: `Round ${index + 1}`, description: index === 1 ? "" : `Result ${index + 1}`, status: (["todo", "in_progress", "done", "skipped"] as const)[index % 4]!, createdAt: time, updatedAt: time }));
const resource = (items: readonly TaskStep[] = steps): StepsResource => ({ projectId, taskId, version: 3n, steps: items });
const panel = (active = true) => <TaskStepsPanel projectId={projectId} taskId={taskId} active={active} renderMarkdown={(text) => <div data-testid="markdown">{text}</div>} />;
beforeEach(() => Object.assign(read, { resource: resource(), status: "ready", error: null, refreshing: false, stale: false, retry: vi.fn() }));

describe("bounded Steps reading", () => {
  it("mounts 100/100/41 globally numbered rows with constant-size numeric navigation", async () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(100);
    expect(screen.getByText("1–100 of 241 steps")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(view.container.querySelector(".step-number")).toHaveTextContent("101");
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(100);
    const input = screen.getByRole("spinbutton", { name: "Page" });
    await userEvent.setup().clear(input);
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.submit(input.closest("form")!);
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(41);
    expect(view.container.querySelector(".step-number")).toHaveTextContent("201");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.change(input, { target: { value: "0" } }); fireEvent.blur(input);
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "1.5" } }); fireEvent.submit(input.closest("form")!);
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "999" } }); fireEvent.submit(input.closest("form")!);
    expect(input).toHaveValue(3);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(input).toHaveValue(2);
  });
  it("retains expansion by stable ID across pages, reorder, refresh and locale changes", () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    const disclosure = screen.getByRole("button", { name: "Round 1" });
    fireEvent.click(disclosure);
    fireEvent.click(screen.getByRole("button", { name: "Round 2" }));
    expect(screen.getByText("No description")).toBeVisible();
    expect(screen.getByText("Result 1")).toBeVisible();
    expect(disclosure).toHaveAttribute("aria-controls", disclosure.closest("li")!.querySelector(".step-detail")!.id);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("button", { name: "Round 1" })).toHaveAttribute("aria-expanded", "true");
    read.resource = resource([steps[1]!, steps[0]!, ...steps.slice(2)]);
    view.rerender(panel());
    expect(screen.getByRole("button", { name: "Round 1" }).closest("li")!.querySelector(".step-number")).toHaveTextContent("2");
    view.setLocale("zh-CN");
    expect(screen.getAllByText("待开始")[0]).toBeVisible();
    expect(screen.getAllByText("已跳过").length).toBeGreaterThan(0);
    expect(screen.getByText("Result 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Round 1" }));
    expect(screen.queryByText("Result 1")).toBeNull();
  });
  it("clamps the visible page when a refreshed collection shrinks and omits pagination for <=100", () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); fireEvent.click(screen.getByRole("button", { name: "Next" }));
    read.resource = resource(steps.slice(0, 100)); view.rerender(panel());
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(100);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(view.container.querySelector(".step-number")).toHaveTextContent("1");
  });
});

describe("Steps read failures", () => {
  it("distinguishes loading, empty, first failure and retained failure, preserving reading and retry", () => {
    Object.assign(read, { resource: null, status: "loading" });
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(screen.getByRole("status", { name: "Loading steps" })).toBeVisible();
    expect(screen.queryByText("No steps yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh steps" })).toBeDisabled();
    read.status = "waiting"; view.rerender(panel());
    expect(screen.getByRole("status", { name: "Loading steps" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh steps" })).toBeEnabled();
    Object.assign(read, { status: "error", error: new ApiError("network") }); view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("Steps could not be loaded.");
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to connect");
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(read.retry).toHaveBeenCalledOnce();
    Object.assign(read, { status: "ready", resource: resource([]), error: null }); view.rerender(panel());
    expect(screen.getByText("No steps yet")).toBeVisible();
    Object.assign(read, { resource: resource(), error: new ApiError("protocol", 200, "protocol", "steps-123") }); view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("Steps could not be updated.");
    expect(screen.getByRole("alert")).toHaveTextContent("previously loaded");
    expect(screen.getByText("steps-123")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Round 1" })); expect(screen.getByText("Result 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh steps" })); expect(read.retry).toHaveBeenCalledTimes(2);
    read.refreshing = true; view.rerender(panel()); expect(screen.getByRole("button", { name: "Refresh steps" })).toHaveAttribute("aria-busy", "true");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" })).toBeDisabled();
  });
  it.each([[404, "unavailable"], [403, "permission"], [500, "server could not"]] as const)("shows the safe %i failure", (status, message) => {
    read.error = new ApiError("server", status, "private_failure");
    renderWithLocale(panel(false), { locale: "en" });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});
