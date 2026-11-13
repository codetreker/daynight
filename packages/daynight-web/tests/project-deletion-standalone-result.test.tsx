import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { pauseAuthRequests } from "../src/api/client";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { browserNavigation } from "../src/app/navigation";
import { navigate } from "../src/app/router";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { detailFixture, graphFixture, resourceResponse } from "./helpers/taskDetail";
import { personalTeamPage } from "./helpers/team";
import { directAccessFixture, taskSyncQuery, taskSyncResponse, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000003";
const otherProject = "00000000-0000-4000-8000-000000000004";
const taskId = "00000000-0000-4000-8000-000000000005";
const teamId = "00000000-0000-4000-8000-000000000701";
const personal = { id: teamId, kind: "personal" as const, name: null };
const user = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: personal };
const now = "2026-10-22T10:00:00Z";
const project = { id: projectId, name: "Project", repoUrl: "https://example.com/repo", createdAt: now, updatedAt: now, ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
const task = detailFixture(otherProject, taskId, { title: "Other task" });
const preview = { observedAt: now, project: { id: projectId, name: project.name, repoUrl: project.repoUrl, ownerTeam: personal }, summary: { taskCount: 0, unfinishedTaskCount: 0, attachmentCount: 0 }, activeClaims: [], nextCursor: null };
const access = (id: string) => ({ ...directAccessFixture(id, userId, "admin"), teamRole: "admin" as const, canTransfer: true });
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(stringifyWireJson(body), { status, headers: viewerHeaders(userId, { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) }) });
const render = createLocaleRender("en");

beforeEach(() => { browserNavigation().dispose(); window.history.replaceState(null, "", `/projects/${projectId}/settings?tab=management`); window.localStorage.clear(); window.sessionStorage.clear(); vi.spyOn(document, "hasFocus").mockReturnValue(true); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(() => { browserNavigation().dispose(); vi.restoreAllMocks(); });

const setup = () => {
  const pending = Promise.withResolvers<Response>();
  let requestId = "";
  let identityFailure = false;
  const fetcher = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url, location.origin).pathname;
    if (path === "/api/v1/me") return Promise.resolve(identityFailure ? json({ error: { code: "internal_error", message: "Unavailable", requestId: "identity-error" } }, 503) : json(user));
    if (path === "/api/v1/teams") return Promise.resolve(json(personalTeamPage(userId)));
    if (path === `/api/v1/teams/${teamId}`) return Promise.resolve(json(personalTeamPage(userId).items[0]));
    if (path === "/api/v1/projects") return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (path === `/api/v1/projects/${projectId}` && init?.method === "DELETE") { requestId = new Headers(init.headers).get("X-Request-ID")!; return pending.promise; }
    if (path === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (path === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access(projectId)));
    if (path === `/api/v1/projects/${projectId}/deletion-preview`) return Promise.resolve(json(preview));
    if (path === `/api/v1/projects/${otherProject}/access`) return Promise.resolve(json(access(otherProject)));
    if (path === `/api/v1/projects/${otherProject}/task-sync`) return Promise.resolve(taskSyncResponse(graphFixture([task]), { viewerId: userId, actorAccess: access(otherProject), query: taskSyncQuery(new URL(url, location.origin)), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === `/api/v1/projects/${otherProject}/task-graph`) return Promise.resolve(resourceResponse(graphFixture([task]), userId));
    if (path === `/api/v1/projects/${otherProject}/tasks/${taskId}`) return Promise.resolve(resourceResponse(task, userId));
    if (path === `/api/v1/projects/${otherProject}/tasks/${taskId}/steps`) return Promise.resolve(json({ projectId: otherProject, taskId, version: 1n, steps: [] }));
    if (path === `/api/v1/projects/${otherProject}/tasks/${taskId}/attachments`) return Promise.resolve(json({ items: [], nextCursor: null }));
    if (path === `/api/v1/projects/${otherProject}/task-assignees`) return Promise.resolve(json({ items: [], unresolvedUserIds: [] }));
    if (path === `/api/v1/projects/${otherProject}/tasks/${taskId}/sessions`) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  return { fetcher, pending, requestId: () => requestId, setIdentityFailure: (value: boolean) => { identityFailure = value; }, writes: () => fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE").length };
};

const submit = async () => {
  const button = await screen.findByRole("button", { name: "Delete project" }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Delete this project?" });
  const field = await within(dialog).findByLabelText("Enter the project name to confirm");
  fireEvent.change(field, { target: { value: "Project" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirm deletion" }));
};

it.each([
  { route: "task", path: `/projects/${otherProject}/tasks/${taskId}`, outcome: "unknown" },
  { route: "attachment", path: `/projects/${otherProject}/tasks/${taskId}/attachments/docs/file.txt`, outcome: "rejected" },
  { route: "not found", path: "/missing-route", outcome: "unknown" },
] as const)("shows a late $outcome deletion outcome on the $route route", async ({ path, outcome }) => {
  const app = setup(); await submit(); await waitFor(() => expect(app.writes()).toBe(1));
  act(() => navigate(path));
  if (outcome === "unknown") await act(async () => app.pending.reject(new TypeError("lost response")));
  else await act(async () => app.pending.resolve(json({ error: { code: "forbidden", message: "Denied", requestId: app.requestId() } }, 403, { "X-Request-ID": app.requestId() })));
  if (outcome === "unknown") {
    expect(await screen.findByText(/project deletion result is unknown/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
    expect(await screen.findByText(/currently accessible; the original result remains unknown/i)).toBeVisible();
  } else {
    expect(await screen.findByText(/you do not have permission to delete this project/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/you do not have permission to delete this project/i)).toBeNull();
  }
  expect(window.location.pathname).toBe(path); expect(app.writes()).toBe(1);
});

it("keeps a dispatched refusal across leaving settings and a paused publication", async () => {
  const app = setup(); await submit(); await waitFor(() => expect(app.writes()).toBe(1));
  const path = `/projects/${otherProject}/tasks/${taskId}`;
  act(() => navigate(path));
  await screen.findByText("Other task");
  const resume = pauseAuthRequests(); const count = app.fetcher.mock.calls.length;
  try {
    await act(async () => app.pending.resolve(json({ error: { code: "forbidden", message: "Denied", requestId: app.requestId() } }, 403, { "X-Request-ID": app.requestId() })));
    expect(screen.queryByText(/you do not have permission to delete this project/i)).toBeNull();
    expect(app.fetcher).toHaveBeenCalledTimes(count); expect(app.writes()).toBe(1);
    act(() => resume());
    expect(await screen.findByText(/you do not have permission to delete this project/i)).toBeVisible();
    expect(window.location.pathname).toBe(path); expect(app.writes()).toBe(1);
  } finally { resume(); }
});

it("keeps success reachable without navigating away from a newer task draft", async () => {
  const app = setup(); await submit(); await waitFor(() => expect(app.writes()).toBe(1));
  const path = `/projects/${otherProject}/tasks/${taskId}?tab=steps`;
  act(() => navigate(path));
  const add = await screen.findByRole("button", { name: "Add step" }); await waitFor(() => expect(add).toBeEnabled()); fireEvent.click(add);
  const draft = screen.getByRole("textbox", { name: "Title" }); fireEvent.change(draft, { target: { value: "Other task draft" } });
  await act(async () => app.pending.resolve(json({ projectId, deleted: true })));
  expect(await screen.findByText(/Project deleted/)).toBeVisible();
  expect(draft).toHaveValue("Other task draft");
  expect(window.location.pathname).toBe(`/projects/${otherProject}/tasks/${taskId}`);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText("Deletion succeeded, but navigation to projects failed.")).toBeNull();
  vi.stubGlobal("innerWidth", 320);
  const keyboard = userEvent.setup(); const toggle = screen.getByRole("button", { name: "Collapse deletion results" });
  toggle.focus(); await keyboard.keyboard("{Enter}");
  expect(toggle).toHaveFocus(); expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/Project deleted/)).not.toBeVisible();
  expect(draft).toBeVisible(); expect(draft).toHaveValue("Other task draft");
  await keyboard.keyboard("{Enter}"); expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/Project deleted/)).toBeVisible();
  expect(draft).toHaveValue("Other task draft");
  expect(screen.queryByRole("button", { name: "Retry navigation" })).toBeNull();
  expect(window.location.pathname).toBe(`/projects/${otherProject}/tasks/${taskId}`);
  expect(draft).toHaveValue("Other task draft");
  expect(app.writes()).toBe(1);
});

it("retains an existing standalone result when focus returns", async () => {
  const app = setup(); await submit(); await waitFor(() => expect(app.writes()).toBe(1));
  act(() => navigate(`/projects/${otherProject}/tasks/${taskId}`));
  await act(async () => app.pending.reject(new TypeError("lost response")));
  expect(await screen.findByText(/project deletion result is unknown/i)).toBeVisible();
  app.setIdentityFailure(true);
  vi.mocked(document.hasFocus).mockReturnValue(false); fireEvent(window, new Event("blur"));
  vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent(window, new Event("focus"));
  expect(screen.getByText(/project deletion result is unknown/i)).toBeVisible();
  expect(screen.getByRole("button", { name: "Check current state" })).toBeEnabled();
});
