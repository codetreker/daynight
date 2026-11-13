import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { IDBObjectStore } from "fake-indexeddb";
import { openDB } from "idb";
import { expect, it, vi } from "vitest";
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from "../src/features/projects/ProjectAccess";
import { pauseAuthRequests } from "../src/api/client";
import { ProjectOwnership } from "../src/features/management/ProjectOwnership";
import { TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { saveDetail } from "../src/features/task-detail/detail-cache";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA } from "../src/features/task-cache/database";
import { createTaskCacheScope, TaskCacheLifecycleChanged } from "../src/features/task-cache/project-cache";
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

it("cancels transfer preparation on pause without dispatching after recovery", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  let session!: ProjectAccessSession, hold = false;
  const pending = Promise.withResolvers<Response>();
  const CaptureAccess = () => { session = useProjectAccess(projectId).session; return null; };
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return hold ? pending.promise : json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) throw new Error("unexpected transfer");
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  let resume: (() => void) | undefined;
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><CaptureAccess /><ProjectOwnership projectId={projectId} projectName="Project" active /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled());
    hold = true; const reads = fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
    act(() => { void session.revalidate(); });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access"))).toHaveLength(reads + 1));
    fireEvent.click(confirm); await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled());
    act(() => { resume = pauseAuthRequests(); });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(0);
    act(() => resume?.()); resume = undefined; hold = false; await act(async () => pending.resolve(json(access)));
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(0);
    expect(within(dialog).getByLabelText("Team ID or link")).toHaveValue(target.id);
  } finally { resume?.(); scope.dispose(); }
});

it("cancels the transfer's inner preparation and releases its guard on pause", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const preparation = Promise.withResolvers<Awaited<ReturnType<typeof scope.beginSync>>>();
  const begin = vi.spyOn(scope, "beginSync");
  const guard = { tryAcquire: vi.fn(() => true), release: vi.fn(), isBlocked: vi.fn(() => false) };
  const retention = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) throw new Error("unexpected transfer");
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); let resume: (() => void) | undefined;
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active guard={guard} onRetentionChange={retention} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled());
    begin.mockClear().mockReturnValueOnce(preparation.promise); fireEvent.click(confirm);
    await waitFor(() => expect(begin).toHaveBeenCalled());
    act(() => { resume = pauseAuthRequests(); });
    await waitFor(() => { expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled(); expect(guard.release).toHaveBeenCalledWith("transfer"); expect(retention).toHaveBeenLastCalledWith(false); });
    act(() => resume?.()); resume = undefined;
    await act(async () => preparation.reject(new Error("late preparation failure")));
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(0);
  } finally { resume?.(); scope.dispose(); }
});

it("cancels a confirmed transfer publication on owner disposal", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const write = Promise.withResolvers<Response>();
  const guard = { tryAcquire: vi.fn(() => true), release: vi.fn(), isBlocked: vi.fn(() => false) }, transferred = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) return write.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); let resume: (() => void) | undefined;
  try {
    const view = createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active guard={guard} onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => write.resolve(json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: null })));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(transferred).not.toHaveBeenCalled(); expect(guard.release).not.toHaveBeenCalled();
    const reads = fetcher.mock.calls.length; view.unmount(); expect(guard.release).toHaveBeenCalledWith("transfer");
    act(() => resume?.()); resume = undefined; await act(async () => { await Promise.resolve(); });
    expect(transferred).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(reads);
  } finally { resume?.(); scope.dispose(); }
});

it("retains a closed transfer until its confirmed receipt is published, then releases it", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const write = Promise.withResolvers<Response>(), transferred = vi.fn(), retention = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) return write.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); let resume: (() => void) | undefined;
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} onRetentionChange={retention} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => write.resolve(json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: { ...access, ownerTeam: target, ownership: { teamId: target.id, version: 2n } } })));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }); await waitFor(() => expect(cancel).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(retention).toHaveBeenLastCalledWith(true);
    fireEvent.click(cancel);
    expect(retention).toHaveBeenLastCalledWith(true); expect(transferred).not.toHaveBeenCalled();
    act(() => resume?.()); resume = undefined; await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(retention).toHaveBeenLastCalledWith(false);
  } finally { resume?.(); scope.dispose(); }
});

it("offers cleanup retry after the confirmed transfer dialog was closed and access withdrawn", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const write = Promise.withResolvers<Response>(), transferred = vi.fn(), retention = vi.fn();
  const revoked: unknown[] = [];
  const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) revoked.push(event); });
  const put = IDBObjectStore.prototype.put; let injectFailure = false, failures = 0;
  const storageFailure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (injectFailure && this.name === "projects" && (args[0] as { state?: string }).state === "invalidated") {
      injectFailure = false; failures++; throw new DOMException("Injected cleanup failure", "QuotaExceededError");
    }
    return put.apply(this, args);
  });
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: null });
    if (url === `/api/v1/projects/${projectId}/transfer`) return write.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); let resume: (() => void) | undefined;
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} onRetentionChange={retention} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => write.resolve(json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: null })));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }); await waitFor(() => expect(cancel).toBeEnabled()); fireEvent.click(cancel);
    injectFailure = true; act(() => resume?.()); resume = undefined;
    const error = await screen.findByText(/transfer succeeded, but project cache cleanup failed/i);
    expect(error).toBeVisible(); expect(failures).toBe(1); expect(transferred).not.toHaveBeenCalled();
    expect(revoked.length).toBeGreaterThan(0); expect(retention).toHaveBeenLastCalledWith(true);
    const retry = within(error.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Retry" });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  } finally { resume?.(); storageFailure.mockRestore(); unsubscribe(); scope.dispose(); }
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


it("releases transfer dialog busy while confirmed cleanup waits for admission", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const cleanup = Promise.withResolvers<boolean>();
  const revoke = vi.spyOn(scope, "revokeProject").mockReturnValueOnce(cleanup.promise);
  const transferred = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: null });
    if (url === `/api/v1/projects/${projectId}/transfer`) return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); let resume: (() => void) | undefined;
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => cleanup.resolve(true));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(transferred).not.toHaveBeenCalled();
    const reads = fetcher.mock.calls.length; expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
    act(() => resume?.()); resume = undefined; await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledTimes(reads);
  } finally { resume?.(); scope.dispose(); }
});

it.each([false, true])("resumes transfer cleanup after admission changes at the ready boundary (brief=%s)", async (brief) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const cleanup = Promise.withResolvers<boolean>();
  const revoke = vi.spyOn(scope, "revokeProject").mockReturnValueOnce(cleanup.promise);
  const originalReady = scope.ready.bind(scope), transferred = vi.fn();
  let inject = false, resume: (() => void) | undefined;
  vi.spyOn(scope, "ready").mockImplementation(async (signal) => {
    if (inject) { inject = false; const release = pauseAuthRequests(); if (brief) release(); else resume = release; throw new TaskCacheLifecycleChanged(); }
    await originalReady(signal);
  });
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: null });
    if (url === `/api/v1/projects/${projectId}/transfer`) return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce()); inject = true;
    await act(async () => cleanup.resolve(true));
    if (!brief) { await waitFor(() => expect(resume).toBeDefined()); expect(transferred).not.toHaveBeenCalled(); act(() => resume?.()); resume = undefined; }
    await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(screen.queryByText(/transfer succeeded, but project cache cleanup failed/i)).toBeNull();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  } finally { resume?.(); scope.dispose(); }
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

it("keeps a later transfer draft when the previous receipt finishes cleanup", async () => {
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const freshAccess = Promise.withResolvers<Response>();
  const newTarget = "00000000-0000-4000-8000-000000000703";
  const ownership = { teamId: target.id, version: access.ownership.version + 1n };
  const transferredAccess = { ...access, ownerTeam: target, ownership };
  let afterTransfer = false;
  let cleanupReadStarted = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) {
      if (afterTransfer) { cleanupReadStarted = true; return freshAccess.promise; }
      return json(access);
    }
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url === `/api/v1/projects/${projectId}/transfer`) {
      afterTransfer = true;
      return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership, actorAccess: transferredAccess });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const transferred = vi.fn();
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" });
    await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    const input = within(dialog).getByLabelText("Team ID or link");
    fireEvent.change(input, { target: { value: target.id } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" });
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(afterTransfer).toBe(true));
    await waitFor(() => expect(cleanupReadStarted).toBe(true));
    await waitFor(() => expect(input).toBeEnabled());
    expect(transferred).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: newTarget } });
    await act(async () => freshAccess.resolve(json(transferredAccess)));
    await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(transferred.mock.calls[0]![0]).toMatchObject({ projectId, ownerTeam: target, ownership });
    expect(screen.getByRole("dialog", { name: "Transfer project" })).toBe(dialog);
    expect(within(dialog).getByLabelText("Team ID or link")).toHaveValue(newTarget);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  } finally { scope.dispose(); }
});

it.each(["success", "cleanup failure"] as const)("keeps a later draft through actual revocation and restored access: %s", async (outcome) => {
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const admission = Promise.withResolvers<void>();
  const revokeProject = scope.revokeProject.bind(scope);
  let cleanupWaiting = false;
  const revoke = vi.spyOn(scope, "revokeProject").mockImplementation(async (...args) => {
    if (!cleanupWaiting) { cleanupWaiting = true; await admission.promise; }
    return revokeProject(...args);
  });
  const events: { generation: string | undefined; error: unknown }[] = [];
  const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) events.push({ generation: event.revokedGeneration, error: event.error }); });
  const put = IDBObjectStore.prototype.put;
  let injectFailure = false, failures = 0;
  const storageFailure = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (injectFailure && this.name === "projects" && (args[0] as { state?: string }).state === "invalidated") {
      injectFailure = false; failures++;
      throw new DOMException("Injected cleanup failure", "QuotaExceededError");
    }
    return put.apply(this, args);
  });
  const newTarget = "00000000-0000-4000-8000-000000000703";
  let session!: ProjectAccessSession;
  const CaptureAccess = () => { session = useProjectAccess(projectId).session; return null; };
  const fetcher = vi.fn(async (url: string) => {
    if (url === `/api/v1/projects/${projectId}/access`) return json(access);
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: null });
    if (url === `/api/v1/projects/${projectId}/transfer`) {
      return json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: access.ownership.version + 1n }, actorAccess: null });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const transferred = vi.fn();
    createLocaleRender("en")(<ProjectAccessBoundary projectId={projectId} initialRead><CaptureAccess /><ProjectOwnership projectId={projectId} projectName="Project" active onTransferred={transferred} /></ProjectAccessBoundary>, { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" });
    await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    const input = within(dialog).getByLabelText("Team ID or link");
    fireEvent.change(input, { target: { value: target.id } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled()); fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" });
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(cleanupWaiting).toBe(true));
    await waitFor(() => expect(input).toBeEnabled());
    expect(revoke).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: newTarget } });
    injectFailure = outcome === "cleanup failure";
    await act(async () => admission.resolve());
    if (outcome === "cleanup failure") {
      await within(dialog).findByText(/transfer succeeded, but project cache cleanup failed/i);
      expect(failures).toBe(1);
      expect(events).toHaveLength(2);
      expect(events[0]!.generation).toBeDefined();
      expect(events[1]!.generation).toBe(events[0]!.generation);
      expect(events[1]!.error).toMatchObject({ category: "storage" });
      expect(transferred).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    }
    await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(revoke).toHaveBeenCalledTimes(outcome === "success" ? 1 : 2);
    expect(session.snapshot().status).toBe("unavailable");
    expect(transferred.mock.calls[0]![0]).toMatchObject({ projectId, ownerTeam: target, actorAccess: null });
    await act(async () => { await session.revalidateAfterMutation(); });
    expect(session.snapshot().status).toBe("ready");
    expect(screen.getByRole("dialog", { name: "Transfer project" })).toBe(dialog);
    expect(within(dialog).getByLabelText("Team ID or link")).toHaveValue(newTarget);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  } finally { admission.resolve(); storageFailure.mockRestore(); unsubscribe(); scope.dispose(); }
}, 20000);

it("retains transfer presentation after leaving and returning to its section", async () => {
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const write = Promise.withResolvers<Response>(), transferred = vi.fn(), observe = vi.fn();
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/access")) return json(access);
    if (url.endsWith("/transfer-preview")) return json({ sourceTeam: source, targetTeam: { ...target, version: 1n }, ownership: access.ownership, actorRole: "admin" });
    if (url.endsWith("/transfer")) return write.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const subject = (active: boolean, generation: number) => <ProjectAccessBoundary projectId={projectId} initialRead><ProjectOwnership projectId={projectId} projectName="Project" active={active} onRoute presentationGeneration={generation} onStateChange={observe} onTransferred={transferred} /></ProjectAccessBoundary>;
  try {
    const view = createLocaleRender("en")(subject(true, 0), { taskCache: { scope } });
    const opener = await screen.findByRole("button", { name: "Transfer project" }); await waitFor(() => expect(opener).toBeEnabled()); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Transfer project" });
    expect(observe).toHaveBeenLastCalledWith({ dirty: false, pending: false, needsAttention: false });
    fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target.id } });
    expect(observe).toHaveBeenLastCalledWith({ dirty: true, pending: false, needsAttention: false });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" }); await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
    expect(observe).toHaveBeenLastCalledWith({ dirty: true, pending: true, needsAttention: false });
    view.rerender(subject(false, 1)); view.rerender(subject(true, 1));
    await act(async () => write.resolve(json({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: target.id, version: 2n }, actorAccess: { ...access, ownerTeam: target, ownership: { teamId: target.id, version: 2n } } })));
    await waitFor(() => expect(transferred).toHaveBeenCalledOnce());
    expect(transferred.mock.calls[0]![1].ownsEditor()).toBe(false);
    expect(screen.getByRole("dialog", { name: "Transfer project" })).toBeVisible();
  } finally { scope.dispose(); }
});
