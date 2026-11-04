import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import type { StepsResource, TaskStep } from "../src/api/task-steps";
import { TaskStepsPanel } from "../src/features/task-detail/steps/TaskStepsPanel";
import { renderWithLocale } from "./helpers/renderWithLocale";

const read = vi.hoisted(() => ({ resource: null as StepsResource | null, status: "loading", error: null as unknown, refreshing: false, stale: true, retry: vi.fn(), canSetStatus: true, setStatus: vi.fn(), canMove: true, move: vi.fn(), reconcile: vi.fn(), mutation: { operation: null as null | { action: string; stepId: string }, phase: "idle", error: null as unknown, reconciling: false, reconciliationError: null as unknown } }));
vi.mock("../src/features/task-detail/useTaskSteps", () => ({ useTaskSteps: () => read }));
const projectId = "10000000-0000-0000-0000-000000000001";
const taskId = "20000000-0000-0000-0000-000000000002";
const time = "2026-11-03T12:34:56.123456Z";
const steps: TaskStep[] = Array.from({ length: 241 }, (_, index) => ({ id: index.toString(16).padStart(8, "0"), title: `Round ${index + 1}`, description: index === 1 ? "" : `Result ${index + 1}`, status: (["todo", "in_progress", "done", "skipped"] as const)[index % 4]!, createdAt: time, updatedAt: time }));
const resource = (items: readonly TaskStep[] = steps): StepsResource => ({ projectId, taskId, version: 3n, steps: items });
const panel = (active = true) => <TaskStepsPanel projectId={projectId} taskId={taskId} active={active} renderMarkdown={(text) => <div data-testid="markdown">{text}</div>} />;
beforeEach(() => Object.assign(read, { resource: resource(steps.slice(0, 4)), status: "ready", error: null, refreshing: false, stale: false, retry: vi.fn(), canSetStatus: true, setStatus: vi.fn(), canMove: true, move: vi.fn(), reconcile: vi.fn(), mutation: { operation: null, phase: "idle", error: null, reconciling: false, reconciliationError: null } }));

describe("Step status", () => {
  it("offers four keyboard-accessible choices and retains the confirmed state until a response", () => {
    renderWithLocale(panel(), { locale: "en" });
    const trigger = screen.getByRole("button", { name: "Status for Round 1: To do" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Status for Round 1" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(4);
    expect(within(menu).getByRole("menuitemradio", { name: "To do" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(menu, { key: "End" });
    expect(within(menu).getByRole("menuitemradio", { name: "Skipped" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
    expect(read.setStatus).toHaveBeenCalledWith("00000000", "done", 3n);
    expect(trigger).toHaveTextContent("To do");
  });
  it("locks shared writes and exposes conflict and unknown readback without replay", () => {
    read.canSetStatus = false;
    read.mutation = { operation: { action: "stepStatus", stepId: "00000000" }, phase: "unknown", error: new ApiError("network"), reconciling: false, reconciliationError: new ApiError("network") };
    const view = renderWithLocale(panel(), { locale: "en" });
    const trigger = screen.getByRole("button", { name: "Status for Round 1: To do" });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("outcome is unknown");
    expect(screen.getByRole("alert")).toHaveTextContent("could not be checked");
    fireEvent.click(screen.getByRole("button", { name: "Read current steps" }));
    expect(read.reconcile).toHaveBeenCalledOnce();
    expect(read.setStatus).not.toHaveBeenCalled();
    read.mutation = { ...read.mutation, phase: "conflict", error: null, reconciliationError: null };
    view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("task changed");
  });
  it("distinguishes a missing step from a permission refusal", () => {
    read.mutation = { operation: { action: "stepStatus", stepId: "00000000" }, phase: "refused", error: new ApiError("server", 404, "not_found", "request-1"), reconciling: false, reconciliationError: null };
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(screen.getByRole("alert")).toHaveTextContent("step was not found");
    expect(screen.getByText("request-1")).toBeVisible();
    read.mutation = { ...read.mutation, error: new ApiError("server", 403, "forbidden") };
    view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("permission");
  });
  it("keeps a reconciled conflict visible while permitting a new decision without another readback", () => {
    read.mutation = { operation: { action: "stepStatus", stepId: "00000000" }, phase: "reconciled", error: new ApiError("server", 409, "version_conflict", "conflict-id"), reconciling: false, reconciliationError: null };
    Object.assign(read.mutation, { reconciledFrom: "conflict" });
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(screen.getByRole("alert")).toHaveTextContent("Steps were read; choose a status again.");
    expect(screen.getByText("conflict-id")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Read current steps" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Status for Round 1: To do" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
    expect(read.setStatus).toHaveBeenCalledWith("00000000", "done", 3n);
    view.setLocale("zh-CN"); expect(screen.getByRole("alert")).toHaveTextContent("已读取步骤，请重新选择状态");
  });
  it("reports that a reconciled unknown outcome remains unknown while permitting another decision", () => {
    read.mutation = { operation: { action: "stepStatus", stepId: "00000000" }, phase: "reconciled", error: new ApiError("network"), reconciling: false, reconciliationError: null };
    Object.assign(read.mutation, { reconciledFrom: "unknown" });
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(screen.getByRole("alert")).toHaveTextContent("Steps were read. The earlier request's outcome remains unknown.");
    expect(screen.queryByRole("button", { name: "Read current steps" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Status for Round 1: To do" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
    expect(read.setStatus).toHaveBeenCalledWith("00000000", "done", 3n);
    view.setLocale("zh-CN"); expect(screen.getByRole("alert")).toHaveTextContent("先前请求的结果仍未知");
  });
  it("shows bounded capacity facts without exposing server diagnostics", () => {
    read.mutation = { operation: { action: "stepStatus", stepId: "00000000" }, phase: "refused", error: new ApiError("server", 409, "steps_limit_exceeded", "request-2", undefined, undefined, "private-server-sentinel", { encodedBytes: 101, maxEncodedBytes: 100 }), reconciling: false, reconciliationError: null };
    renderWithLocale(panel(), { locale: "en" });
    expect(screen.getByRole("alert")).toHaveTextContent("Encoded size: 101 bytes; limit: 100 bytes.");
    expect(screen.queryByText("private-server-sentinel")).toBeNull();
    expect(screen.getByText("request-2")).toBeVisible();
  });
});

describe("bounded Steps reading", () => {
  it("mounts 100/100/41 globally numbered rows with numeric navigation and stable expansion", () => {
    read.resource = resource();
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(100);
    expect(screen.getByText("1–100 of 241 steps")).toBeVisible();
    const controls = within(screen.getByRole("navigation", { name: "Steps pages" }));
    const next = controls.getByRole("button", { name: "Next" });
    const previous = controls.getByRole("button", { name: "Previous" });
    expect(previous).toBeDisabled();
    const disclosure = within(view.container.querySelector(".step-row")!).getByRole("button", { name: "Round 1" });
    fireEvent.click(disclosure);
    fireEvent.click(next);
    expect(view.container.querySelector(".step-number")).toHaveTextContent("101");
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(100);
    const input = controls.getByRole("spinbutton", { name: "Page" });
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.submit(input.closest("form")!);
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(41);
    expect(view.container.querySelector(".step-number")).toHaveTextContent("201");
    expect(next).toBeDisabled();
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.change(input, { target: { value: "0" } }); fireEvent.blur(input);
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "1.5" } }); fireEvent.submit(input.closest("form")!);
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "999" } }); fireEvent.submit(input.closest("form")!);
    expect(input).toHaveValue(3);
    fireEvent.click(previous);
    expect(input).toHaveValue(2);
    fireEvent.click(previous);
    expect(within(view.container.querySelector(".step-row")!).getByRole("button", { name: "Round 1" })).toHaveAttribute("aria-expanded", "true");
  });
  it("retains expansion by stable ID across reorder, refresh and locale changes", () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    const disclosure = screen.getByRole("button", { name: "Round 1" });
    fireEvent.click(disclosure);
    fireEvent.click(screen.getByRole("button", { name: "Round 2" }));
    expect(screen.getByText("No description")).toBeVisible();
    expect(screen.getByText("Result 1")).toBeVisible();
    expect(disclosure).toHaveAttribute("aria-controls", disclosure.closest("li")!.querySelector(".step-detail")!.id);
    expect(screen.getByRole("button", { name: "Round 1" })).toHaveAttribute("aria-expanded", "true");
    read.resource = resource([steps[1]!, steps[0]!, steps[2]!, steps[3]!]);
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
    read.resource = resource();
    const view = renderWithLocale(panel(), { locale: "en" });
    const controls = within(screen.getByRole("navigation", { name: "Steps pages" }));
    const next = controls.getByRole("button", { name: "Next" });
    fireEvent.click(next); fireEvent.click(next);
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
    Object.assign(read, { resource: resource(steps.slice(0, 2)), error: new ApiError("protocol", 200, "protocol", "steps-123") }); view.rerender(panel());
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


describe("Step position", () => {
  it("uses the complete order for boundary and adjacent moves", () => {
    read.resource = resource();
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    expect(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Move to start" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to end" }));
    expect(read.move).toHaveBeenCalledWith("00000000", { position: "last" }, 3n);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Steps pages" })).getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 101" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(read.move).toHaveBeenLastCalledWith("00000064", { before: "00000063" }, 3n);
    expect(view.container.querySelectorAll(".step-row")).toHaveLength(100);
  });
  it("bounds and filters target choices while keeping an off-page selection", () => {
    read.resource = resource();
    renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const dialog = screen.getByRole("dialog", { name: "Move step" });
    const choices = within(dialog).getByRole("radiogroup", { name: "Matching steps" });
    expect(within(choices).getAllByRole("radio")).toHaveLength(100);
    expect(within(choices).queryByRole("radio", { name: /Round 1, 00000000/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(choices).getByRole("radio", { name: /Round 102, 00000065/ }));
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search name or ID" }), { target: { value: "000000ef" } });
    expect(within(choices).getAllByRole("radio")).toHaveLength(1);
    expect(within(dialog).getByText("Round 102")).toBeVisible();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Placement" }), { target: { value: "after" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(read.move).toHaveBeenCalledWith("00000000", { after: "00000065" }, 3n);
  });
  it("restores expansion and focus at the actual confirmed page", async () => {
    read.resource = resource();
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Round 1" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to end" }));
    read.mutation = { operation: { action: "stepPosition", stepId: "00000000" }, phase: "pending", error: null, reconciling: false, reconciliationError: null }; view.rerender(panel());
    expect(screen.getByRole("button", { name: "Round 1" })).toHaveAttribute("aria-expanded", "true");
    read.resource = resource([...steps.slice(1), steps[0]!]);
    read.mutation = { ...read.mutation, phase: "confirmed" }; view.rerender(panel());
    await waitFor(() => {
      expect(screen.getByText("201–241 of 241 steps")).toBeVisible();
      expect(screen.getByRole("button", { name: "Round 1" })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: "More actions for Round 1" })).toHaveFocus();
      expect(screen.getByRole("button", { name: "Round 1" }).closest("li")!.querySelector(".step-number")).toHaveTextContent("241");
    });
  });
  it("returns focus after a confirmed relative move within the same page", () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(screen.getByRole("radio", { name: /Round 3, 00000002/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    read.mutation = { operation: { action: "stepPosition", stepId: "00000000" }, phase: "pending", error: null, reconciling: false, reconciliationError: null }; view.rerender(panel());
    read.resource = resource([steps[1]!, steps[0]!, steps[2]!, steps[3]!]);
    read.mutation = { ...read.mutation, phase: "confirmed" }; view.rerender(panel());
    expect(screen.getByRole("button", { name: "More actions for Round 1" })).toHaveFocus();
  });
  it("clears the picker across retirement and does not reopen it after access returns", () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    expect(screen.getByRole("dialog", { name: "Move step" })).toBeVisible();
    read.resource = null; view.rerender(panel());
    read.resource = resource(steps.slice(0, 4)); view.rerender(panel());
    expect(screen.queryByRole("dialog", { name: "Move step" })).toBeNull();
  });
  it("accepts numeric target navigation after the collection shrinks", () => {
    read.resource = resource(Array.from({ length: 350 }, (_, index) => ({ ...steps[index % steps.length]!, id: index.toString(16).padStart(8, "0"), title: `Round ${index + 1}` })));
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const input = screen.getByRole("spinbutton", { name: "Target result page" });
    fireEvent.change(input, { target: { value: "4" } }); fireEvent.submit(input.closest("form")!);
    read.resource = resource(steps); view.rerender(panel());
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "1" } }); fireEvent.submit(input.closest("form")!);
    expect(input).toHaveValue(1);
    expect(screen.getByRole("radio", { name: /Round 2, 00000001/ })).toBeVisible();
  });
  it("reports invalid self-reference and missing anchors as position errors", () => {
    read.mutation = { operation: { action: "stepPosition", stepId: "00000000" }, phase: "refused", error: new ApiError("server", 400, "invalid_input"), reconciling: false, reconciliationError: null };
    const view = renderWithLocale(panel(), { locale: "en" });
    expect(screen.getByRole("alert")).toHaveTextContent("target must be a different step");
    read.mutation = { ...read.mutation, error: new ApiError("server", 404, "not_found") }; view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("step or target was not found");
    fireEvent.click(screen.getByRole("button", { name: "Read current steps" }));
    expect(read.retry).toHaveBeenCalledOnce();
  });
  it("keeps missing anchors explicit and offers readback after an unknown result", () => {
    const view = renderWithLocale(panel(), { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Round 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    fireEvent.click(screen.getByRole("radio", { name: /Round 2, 00000001/ }));
    read.resource = resource([steps[0]!, steps[2]!]); view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("target step is no longer available");
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    read.mutation = { operation: { action: "stepPosition", stepId: "00000000" }, phase: "unknown", error: new ApiError("network"), reconciling: false, reconciliationError: null }; view.rerender(panel());
    expect(screen.getByRole("alert")).toHaveTextContent("move outcome is unknown");
    fireEvent.click(screen.getByRole("button", { name: "Read current steps" }));
    expect(read.reconcile).toHaveBeenCalledOnce(); expect(read.move).not.toHaveBeenCalled();
  });
});
