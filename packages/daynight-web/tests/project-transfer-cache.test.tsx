import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { openDB } from "idb";
import { expect, it, vi } from "vitest";
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from "../src/features/projects/ProjectAccess";
import { pauseAuthRequests } from "../src/api/client";
import { ProjectOwnership } from "../src/features/management/ProjectOwnership";
import { TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { saveDetail } from "../src/features/task-detail/detail-cache";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA } from "../src/features/task-cache/database";
import { createTaskCacheScope } from "../src/features/task-cache/project-cache";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { detailFixture, graphFixture, resourceResponse } from "./helpers/taskDetail";
import { directAccessFixture, taskSyncFromGraph, TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

vi.mock("../src/features/teams/TeamsProvider", () => ({ useTeams: () => ({ list: { items: [], status: "ready", cursor: null }, refreshList: vi.fn(), loadMore: vi.fn() }) }));

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const source = { id: "00000000-0000-4000-8000-000000000701", kind: "personal" as const, name: null };
const target = { id: "00000000-0000-4000-8000-000000000702", kind: "ordinary" as const, name: "Destination" };
const access = { ...directAccessFixture(projectId, TEST_VIEWER_ID, "admin"), teamRole: "admin" as const, canTransfer: true, directGrant: null };
const json = (body: unknown) => new Response(stringifyWireJson(body), { headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });

it.each(["same", "demoted", "ownership"] as const)("keeps the transfer dialog stable while access is checked and gates submission for %s access", async (outcome) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  let session!: ProjectAccessSession;
  const CaptureAccess = () => { session = useProjectAccess(projectId).session; return null; };
  const pending = Promise.withResolvers<Response>();
  let hold = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return hold ? pending.promise : json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: access });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><CaptureAccess /><ProjectOwnership projectId={projectId} projectName="Project" active /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" });
    await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    const input = within(dialog).getByLabelText("Team ID or link") as HTMLInputElement;
    fireEvent.change(input, { target: { value: target.id } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" });
    await waitFor(() => expect(confirm).toBeEnabled());
    input.focus(); input.setSelectionRange(2, 5);
    hold = true;
    const reads = fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
    act(() => { void session.revalidate(); });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access"))).toHaveLength(reads + 1));
    expect(session.snapshot().refreshing).toBe(true);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input).toHaveFocus(); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(5);
    expect(input).toHaveValue(target.id); expect(confirm).toBeEnabled();
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(0);
    hold = false;
    const fresh = outcome === "demoted" ? { ...access, teamRole: "member", effectiveRole: "member", canTransfer: false } : outcome === "ownership" ? { ...access, ownership: { ...access.ownership, version: access.ownership.version + 1n } } : { ...access, ownership: { ...access.ownership } };
    await act(async () => pending.resolve(json(fresh)));
    if (outcome === "same") await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
    else { await waitFor(() => expect(session.snapshot().refreshing).toBe(false)); expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(0); }
  } finally { scope.dispose(); }
});

it("withdraws an open Task and its persisted cache after a confirmed transfer without actor access", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope), signal = new AbortController().signal;
  const detail = detailFixture(projectId, taskId, { description: "Private cached task" });
  const sync = taskSyncFromGraph(graphFixture([detail]), { actorAccess: access, versionForTask: () => detail.version, propertiesForTask: () => detail.properties });
  const ticket = await scope.beginSync(projectId, signal);
  await scope.applySync(ticket, sync, signal);
  await saveDetail(scope, await scope.beginSync(projectId, signal), detail, signal);
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/tasks/${taskId}`) return resourceResponse(detail, TEST_VIEWER_ID);
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: null });
    if (url === `/api/v1/projects/${projectId}/transfer`) return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    sessions.observe(projectId, taskId, scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)!);
    sessions.load(projectId, taskId, 1, "open");
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.description).toBe("Private cached task"));
    const connection = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
    expect(await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeDefined();
    const transferred = vi.fn();
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const button = await screen.findByRole("button", { name: "Transfer project" });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
    await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(transferred.mock.calls[0]![0]).toMatchObject({ actorAccess: null, ownerTeam: target });
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    expect(sessions.snapshot(projectId, taskId).detail).toBeNull();
    expect(await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
    connection.close();
  } finally { sessions.dispose(); scope.dispose(); }
});


it("waits for identity before retrying cleanup and before publishing the transfer receipt", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const cleanup = Promise.withResolvers<boolean>();
  const revoke = vi.spyOn(scope, "revokeProject").mockRejectedValueOnce(new Error("cleanup failed")).mockReturnValueOnce(cleanup.promise);
  let accessSession!: ProjectAccessSession;
  const CaptureAccess = () => { accessSession = useProjectAccess(projectId).session; return null; };
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: null });
    if (url === `/api/v1/projects/${projectId}/transfer`) return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const transferred = vi.fn();
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><CaptureAccess /><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const button = await screen.findByRole("button", { name: "Transfer project" });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
    await within(dialog).findByText(/transfer succeeded, but project cache cleanup failed/i);
    const first = pauseAuthRequests();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await act(async () => { await Promise.resolve(); }); expect(revoke).toHaveBeenCalledTimes(1);
    first(); await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    const second = pauseAuthRequests();
    await act(async () => cleanup.resolve(true));
    expect(transferred).not.toHaveBeenCalled();
    expect(accessSession.snapshot().status).toBe("ready");
    second(); await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(accessSession.snapshot().status).toBe("unavailable");
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  } finally { scope.dispose(); }
});
