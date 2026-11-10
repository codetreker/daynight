import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { browserNavigation } from "../src/app/navigation";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { personalTeamPage } from "./helpers/team";
import { directAccessFixture, taskSyncQuery, taskSyncResponse, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000003";
const taskId = "00000000-0000-4000-8000-000000000004";
const otherTask = "00000000-0000-4000-8000-000000000005";
const teamId = "00000000-0000-4000-8000-000000000701";
const root = `/api/v1/projects/${projectId}`;
const personal = { id: teamId, kind: "personal" as const, name: null };
const user = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: personal };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: viewerHeaders(userId, { "Content-Type": "application/json" }) });
const missing = () => json({ error: { code: "not_found", message: "Missing", requestId: "missing" } }, 404);
const render = createLocaleRender("en");

beforeEach(() => { browserNavigation().dispose(); window.localStorage.clear(); window.sessionStorage.clear(); vi.spyOn(document, "hasFocus").mockReturnValue(true); });

const install = (deletedProject: boolean) => {
  const task = detailFixture(projectId, otherTask, { title: "Other project task" });
  const access = { ...directAccessFixture(projectId, userId, "admin"), teamRole: "admin" as const, canTransfer: true };
  const fetcher = vi.fn((url: string) => {
    const path = new URL(url, location.origin).pathname;
    if (path === "/api/v1/me") return Promise.resolve(json(user));
    if (path === "/api/v1/teams") return Promise.resolve(json(personalTeamPage(userId)));
    if (path === `/api/v1/teams/${teamId}`) return Promise.resolve(json(personalTeamPage(userId).items[0]));
    if (path === "/api/v1/projects") return Promise.resolve(json({ items: [], nextCursor: null }));
    if (path === `${root}/task-sync` && !deletedProject) return Promise.resolve(taskSyncResponse(graphFixture([task]), { viewerId: userId, actorAccess: access, query: taskSyncQuery(new URL(url, location.origin)), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === `${root}/access` && !deletedProject) return Promise.resolve(json(access));
    if (path.startsWith(`${root}/`)) return Promise.resolve(missing());
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
};

it.each([`/projects/${projectId}/tasks/${taskId}`, `/projects/${projectId}/tasks/${taskId}/attachments/docs/guide.md`])("offers the project list from a deleted Project's old link %s", async (path) => {
  window.history.replaceState(null, "", path); install(true); render(<AuthenticatedApp />);
  expect(await screen.findByRole("heading", { name: "Project not found or access unavailable" })).toBeVisible();
  const back = screen.getByRole("link", { name: "Back to projects" });
  expect(back).toHaveAttribute("href", "/projects"); fireEvent.click(back);
  await waitFor(() => expect(window.location.pathname).toBe("/projects"));
});

it("keeps a missing Task distinct from an unavailable Project", async () => {
  window.history.replaceState(null, "", `/projects/${projectId}/tasks/${taskId}`);
  const fetcher = install(false); render(<AuthenticatedApp />);
  expect(await screen.findByText("This task can no longer be read. Refresh the task graph.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Project not found or access unavailable" })).toBeNull();
  expect(screen.getByRole("link", { name: "Return to task project" })).toHaveAttribute("href", `/projects/${projectId}`);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith(`/tasks/${taskId}`))).toBe(true);
});
