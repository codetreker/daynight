import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { browserNavigation } from "../src/app/navigation";
import { navigate } from "../src/app/router";
import { DeletionResultNotices, useDeletionNavigation } from "../src/features/management/deletion-navigation";
import { createTaskCacheScope } from "../src/features/task-cache/project-cache";
import { createLocaleRender } from "./helpers/renderWithLocale";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000003";
const render = createLocaleRender("en");
let scope: ReturnType<typeof createTaskCacheScope>;
let state: ReturnType<typeof useDeletionNavigation>;
const Harness = () => { state = useDeletionNavigation(scope, vi.fn()); return <DeletionResultNotices state={state} />; };

beforeEach(() => {
  browserNavigation().dispose(); window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  invalidateAuthRequests(); scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
});
afterEach(() => { scope.dispose(); browserNavigation().dispose(); invalidateAuthRequests(); });

it.each(["unknown", "rejected"] as const)("keeps a %s result visible across navigation", async (kind) => {
  const check = vi.fn(async () => "unavailable" as const);
  const error = kind === "rejected" ? new ApiError("server", 403, "forbidden", "request-id") : new Error("lost response");
  render(<Harness />);
  act(() => { state.outcome(projectId, kind, error, check); navigate("/workers"); });
  expect(window.location.pathname).toBe("/workers");
  if (kind === "unknown") {
    expect(screen.getByText(/project deletion result is unknown/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
    expect(await screen.findByText(/currently unavailable; the original result remains unknown/i)).toBeVisible();
    expect(check).toHaveBeenCalledOnce();
  } else {
    expect(screen.getByText(/you do not have permission to delete this project/i)).toBeVisible();
    expect(check).not.toHaveBeenCalled();
  }
});

it("keeps success and retries navigation after an unrelated dirty draft blocks it", async () => {
  render(<Harness />);
  const nav = browserNavigation();
  const unregister = nav.register({ scope: { identity: {}, projectId: "another-project", taskId: "task" }, isDirty: () => true, discard: vi.fn(), survives: () => false });
  const finish = vi.fn(async () => {});
  act(() => state.complete({ projectId, deleted: true }, finish));
  expect(await screen.findByText("Deletion succeeded, but navigation to projects failed.")).toBeVisible();
  expect(screen.getByText(/Project deleted/)).toBeVisible(); expect(window.location.pathname).not.toBe("/projects");
  act(() => { nav.cancel(); unregister(); });
  fireEvent.click(screen.getByRole("button", { name: "Retry navigation" }));
  await waitFor(() => expect(window.location.pathname).toBe("/projects"));
  expect(finish).toHaveBeenCalledOnce();
});

it("holds a confirmed receipt until the original identity check completes", async () => {
  render(<Harness />);
  const resume = pauseAuthRequests(); const finish = vi.fn(async () => {});
  act(() => state.complete({ projectId, deleted: true }, finish));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByText(/Project deleted/)).toBeNull(); expect(finish).not.toHaveBeenCalled();
  expect(window.location.pathname).not.toBe("/projects");
  act(() => resume());
  expect(await screen.findByText(/Project deleted/)).toBeVisible();
  expect(finish).toHaveBeenCalledOnce();
});

it("cancels a held publication when its owner unmounts", async () => {
  const view = render(<Harness />);
  const resume = pauseAuthRequests(); const finish = vi.fn(async () => {});
  act(() => state.complete({ projectId, deleted: true }, finish));
  view.unmount();
  act(() => resume());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(finish).not.toHaveBeenCalled();
  expect(window.location.pathname).not.toBe("/projects");
});

it("supersedes a held publication for the same project", async () => {
  render(<Harness />);
  const resume = pauseAuthRequests();
  const older = vi.fn(async () => {}), newer = vi.fn(async () => {});
  act(() => { state.complete({ projectId, deleted: true }, older); state.complete({ projectId, deleted: true }, newer); });
  expect(older).not.toHaveBeenCalled(); expect(newer).not.toHaveBeenCalled();
  act(() => resume());
  expect(await screen.findByText(/Project deleted/)).toBeVisible();
  expect(older).not.toHaveBeenCalled(); expect(newer).toHaveBeenCalledOnce();
});

it("does not navigate after leaving and returning to the submission route", async () => {
  render(<Harness />);
  const origin = browserNavigation().snapshot();
  const resume = pauseAuthRequests(); const finish = vi.fn(async () => {});
  act(() => state.complete({ projectId, deleted: true }, finish, origin));
  act(() => { navigate("/workers"); navigate(`/projects/${projectId}/settings`); });
  expect(browserNavigation().snapshot().entryId).not.toBe(origin.entryId);
  act(() => resume());
  expect(await screen.findByText(/Project deleted/)).toBeVisible();
  expect(finish).toHaveBeenCalledOnce();
  expect(window.location.pathname).toBe(`/projects/${projectId}/settings`);
});

it("keeps a confirmed receipt visible when cleanup fails and retries only cleanup", async () => {
  render(<Harness />);
  const finish = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("storage failure")).mockResolvedValueOnce(undefined);
  act(() => state.complete({ projectId, deleted: true }, finish));
  expect(await screen.findByText("Deletion succeeded, but local cache cleanup failed.")).toBeVisible();
  expect(screen.getByText(/Project deleted/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
  await waitFor(() => expect(finish).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("Deletion succeeded, but local cache cleanup failed.")).toBeNull());
  expect(screen.getByText(/Project deleted/)).toBeVisible();
});

it("does not publish a held receipt when its identity is retired", async () => {
  render(<Harness />);
  const resume = pauseAuthRequests();
  const finish = vi.fn(async () => {});
  act(() => state.complete({ projectId, deleted: true }, finish));
  act(() => scope.dispose());
  act(() => resume());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByText(/Project deleted/)).toBeNull();
  expect(window.location.pathname).not.toBe("/projects");
});

it("replaces a prior refusal when a later deletion is confirmed", async () => {
  render(<Harness />);
  act(() => state.outcome(projectId, "rejected", new ApiError("server", 409, "active_worker_claims", "request-id"), async () => "available"));
  expect(screen.getByText(/Active Worker claims prevented deletion/)).toBeVisible();
  act(() => state.complete({ projectId, deleted: true }, async () => {}));
  expect(await screen.findByText(/Project deleted/)).toBeVisible();
  expect(screen.queryByText(/Active Worker claims prevented deletion/)).toBeNull();
});
