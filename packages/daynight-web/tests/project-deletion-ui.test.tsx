import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { IDBObjectStore } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import type { ProjectAccess } from "../src/api/auth-types";
import type { ProjectDeletionReceipt } from "../src/api/project-deletion";
import { getProject } from "../src/api/project-settings";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { browserNavigation } from "../src/app/navigation";
import { ProjectDeletion } from "../src/features/management/ProjectDeletion";
import { DeletionResultNotices, useDeletionNavigation } from "../src/features/management/deletion-navigation";
import { useProjectManagementGuard } from "../src/features/management/ProjectManagementGuard";
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from "../src/features/projects/ProjectAccess";
import { ProjectPage } from "../src/features/projects/ProjectPage";
import { createTaskCacheScope } from "../src/features/task-cache/project-cache";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA } from "../src/features/task-cache/database";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { personalTeamPage } from "./helpers/team";
import { directAccessFixture, taskSyncFromGraph, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

const projectId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000001";
const access: ProjectAccess = { ...directAccessFixture(projectId, userId, "admin"), teamRole: "admin", canTransfer: true };
const preview = { observedAt: "2026-10-22T10:00:00Z", project: { id: projectId, name: "Project", repoUrl: "https://example.com/repo", ownerTeam: access.ownerTeam }, summary: { taskCount: 2, unfinishedTaskCount: 1, attachmentCount: 3 }, activeClaims: [], nextCursor: null };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(stringifyWireJson(body), { status, headers: viewerHeaders(userId, { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) }) });
const render = createLocaleRender("en", { taskCache: { viewerId: userId } });

const Harness = () => {
  const guard = useProjectManagementGuard();
  return <ProjectAccessBoundary projectId={projectId} initialRead><button type="button" onClick={() => guard.tryAcquire("settings")}>Hold settings</button><button type="button" onClick={() => guard.release("settings")}>Release settings</button><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} /></ProjectAccessBoundary>;
};

const setup = (write: (init: RequestInit) => Promise<Response>, onPreview?: () => Response) => {
  const fetcher = vi.fn((url: string, init: RequestInit = {}) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(onPreview?.() ?? json(preview));
    if (url === `/api/v1/projects/${projectId}` && init.method === "DELETE") return write(init);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<Harness />); return fetcher;
};
const open = async () => {
  const button = await screen.findByRole("button", { name: "Delete project" });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Delete this project?" });
  await within(dialog).findByText("https://example.com/repo"); return dialog;
};
const confirm = (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText("Enter the project name to confirm"), { target: { value: "Project" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm deletion" }));
};
const writes = (fetcher: ReturnType<typeof setup>) => fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");

beforeEach(() => { invalidateAuthRequests(); vi.spyOn(document, "hasFocus").mockReturnValue(true); });

it("shows the preview and cancel closes without deleting", async () => {
  const fetcher = setup(() => Promise.reject(new Error("unexpected delete")));
  const dialog = await open();
  expect(within(dialog).getByText(/2 tasks/)).toBeVisible();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(writes(fetcher)).toHaveLength(0);
});

it("blocks duplicate deletion and other management writes while the request is pending", async () => {
  const pending = Promise.withResolvers<Response>(); const fetcher = setup(() => pending.promise);
  const dialog = await open(); confirm(dialog);
  await waitFor(() => expect(writes(fetcher)).toHaveLength(1));
  expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Deleting…" }));
  expect(writes(fetcher)).toHaveLength(1);
  await act(async () => pending.reject(new TypeError("lost response")));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(/deletion result is unknown/i);
});

it("cancels preparation on pause without dispatching or resuming DELETE", async () => {
  const fetcher = setup(() => Promise.reject(new Error("unexpected delete")));
  const dialog = await open();
  let resume!: () => void;
  act(() => { confirm(dialog); resume = pauseAuthRequests(); });
  try {
    expect(writes(fetcher)).toHaveLength(0);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    const count = fetcher.mock.calls.length;
    act(() => resume());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(writes(fetcher)).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(count);
  } finally { resume(); }
});

it.each(["unknown", "rejected"] as const)("settles a dispatched %s result during pause without a read or replay", async (kind) => {
  const pending = Promise.withResolvers<Response>(); let requestId = "";
  const fetcher = setup((init) => { requestId = new Headers(init.headers).get("X-Request-ID")!; return pending.promise; });
  const dialog = await open(); confirm(dialog);
  await waitFor(() => expect(writes(fetcher)).toHaveLength(1));
  const resume = pauseAuthRequests();
  const count = fetcher.mock.calls.length;
  try {
    await act(async () => {
      if (kind === "unknown") pending.reject(new TypeError("lost response"));
      else pending.resolve(json({ error: { code: "forbidden", message: "Denied", requestId } }, 403, { "X-Request-ID": requestId }));
    });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(within(dialog).getByLabelText("Enter the project name to confirm")).toHaveValue("Project");
    expect(fetcher).toHaveBeenCalledTimes(count); expect(writes(fetcher)).toHaveLength(1);
    act(() => resume());
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(kind === "unknown" ? /deletion result is unknown/i : /no longer have permission/i);
    expect(fetcher).toHaveBeenCalledTimes(count); expect(writes(fetcher)).toHaveLength(1);
  } finally { resume(); }
});

it("retains a confirmed receipt and the dialog during pause without cleanup or reads", async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>();
  const revoke = vi.spyOn(scope, "revokeProject");
  const complete = vi.fn<(receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">) => void>();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={complete} /></ProjectAccessBoundary>; };
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
    const resume = pauseAuthRequests(); const count = fetcher.mock.calls.length;
    try {
      await act(async () => pending.resolve(json({ projectId, deleted: true })));
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
      expect(within(dialog).getByLabelText("Enter the project name to confirm")).toHaveValue("Project");
      expect(revoke).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(count);
      act(() => resume());
      await waitFor(() => expect(complete).toHaveBeenCalledOnce());
      expect(complete.mock.calls[0]![0]).toEqual({ projectId, deleted: true });
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    } finally { resume(); }
  } finally { scope.dispose(); }
});

it("does not clear a newer confirmation input when an older receipt is finalized", async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>();
  const revoke = vi.spyOn(scope, "revokeProject").mockResolvedValue(false);
  const complete = vi.fn<(receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">) => void>();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={complete} /></ProjectAccessBoundary>; };
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const input = within(dialog).getByLabelText("Enter the project name to confirm");
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "new input" } });
    await act(async () => { await complete.mock.calls[0]![1](); });
    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible();
    expect(input).toHaveValue("new input");
  } finally { scope.dispose(); }
});

it("does not close a reopened dialog when the earlier deletion is finalized", async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>();
  const revoke = vi.spyOn(scope, "revokeProject").mockResolvedValue(false);
  const complete = vi.fn<(receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">) => void>();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={complete} /></ProjectAccessBoundary>; };
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<Subject />, { taskCache: { scope } });
    const first = await open(); confirm(first);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    const second = await open();
    const input = within(second).getByLabelText("Enter the project name to confirm");
    fireEvent.change(input, { target: { value: "new input" } });
    await act(async () => { await complete.mock.calls[0]![1](); });
    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible();
    expect(input).toHaveValue("new input");
  } finally { scope.dispose(); }
});

it("keeps the dialog during a pause that starts while receipt cleanup is in progress", async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const cleanup = Promise.withResolvers<boolean>();
  const revoke = vi.spyOn(scope, "revokeProject").mockReturnValue(cleanup.promise);
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return Promise.resolve(json({ projectId, deleted: true }));
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} /></ProjectAccessBoundary>; };
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests(); const count = fetcher.mock.calls.length;
    try {
      await act(async () => cleanup.resolve(true));
      expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible();
      expect(within(dialog).getByLabelText("Enter the project name to confirm")).toHaveValue("Project");
      expect(fetcher).toHaveBeenCalledTimes(count);
      act(() => resume());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally { resume(); }
  } finally { scope.dispose(); }
});

it("does not dispatch while another Project management operation owns the guard", async () => {
  const fetcher = setup(() => Promise.reject(new Error("unexpected delete")));
  await screen.findByRole("button", { name: "Delete project" });
  fireEvent.click(screen.getByRole("button", { name: "Hold settings" }));
  expect(screen.getByRole("button", { name: "Delete project" })).toBeDisabled();
  expect(writes(fetcher)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Release settings" }));
  await open(); expect(writes(fetcher)).toHaveLength(0);
});

it("keeps an unknown result after a read-only check and never resends DELETE", async () => {
  let previews = 0;
  const fetcher = setup(() => Promise.reject(new TypeError("lost response")), () => { previews++; return json(preview); });
  const dialog = await open(); confirm(dialog);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(/deletion result is unknown/i);
  fireEvent.click(within(dialog).getByRole("button", { name: "Check current state" }));
  expect(await within(dialog).findByText(/original deletion result remains unknown/i)).toBeVisible();
  expect(previews).toBe(2); expect(writes(fetcher)).toHaveLength(1);
});

it("keeps an unknown result when a later read returns 404", async () => {
  let previews = 0;
  const fetcher = setup(() => Promise.reject(new TypeError("lost response")), () => {
    previews++;
    return previews === 1 ? json(preview) : json({ error: { code: "not_found", message: "Missing", requestId: "missing-project" } }, 404);
  });
  const dialog = await open(); confirm(dialog);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(/deletion result is unknown/i);
  fireEvent.click(within(dialog).getByRole("button", { name: "Check current state" }));
  expect(await within(dialog).findByText("The project is currently unavailable; the original deletion result remains unknown.")).toBeVisible();
  expect(writes(fetcher)).toHaveLength(1);
});

it("shows a correlated definite refusal without reporting an unknown outcome", async () => {
  const fetcher = setup(async (init) => {
    const requestId = new Headers(init.headers).get("X-Request-ID")!;
    return json({ error: { code: "forbidden", message: "Denied", requestId } }, 403, { "X-Request-ID": requestId });
  });
  const dialog = await open(); confirm(dialog);
  expect(await within(dialog).findByText("You no longer have permission to delete this project.")).toBeVisible();
  expect(within(dialog).queryByText(/deletion result is unknown/i)).toBeNull(); expect(writes(fetcher)).toHaveLength(1);
});

it("shows the preview's forbidden response and revalidates the actor's access", async () => {
  const recheck = Promise.withResolvers<Response>();
  let reads = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) { reads++; return reads === 1 ? Promise.resolve(json(access)) : recheck.promise; }
    if (url.includes("/deletion-preview")) return Promise.resolve(json({ error: { code: "forbidden", message: "Denied", requestId: "preview-denied" } }, 403));
    if (init?.method === "DELETE") throw new Error("Unexpected deletion");
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<Harness />);
  const button = await screen.findByRole("button", { name: "Delete project" });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Delete this project?" });
  expect(await within(dialog).findByText("You no longer have permission to delete this project.")).toBeVisible();
  expect(within(dialog).getByText("preview-denied")).toBeVisible();
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => recheck.resolve(json({ ...access, teamRole: "member", canTransfer: false })));
  expect(within(dialog).queryByLabelText("Enter the project name to confirm")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Confirm deletion" })).toBeDisabled();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
});

it("does not publish an old identity's late deletion result", async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>();
  const complete = vi.fn(), outcome = vi.fn();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={complete} onOutcome={outcome} /></ProjectAccessBoundary>; };
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    act(() => scope.dispose());
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    expect(complete).not.toHaveBeenCalled(); expect(outcome).not.toHaveBeenCalled();
  } finally { scope.dispose(); }
});

it("does not publish a delayed preview after owner-admin access is lost", async () => {
  const pending = Promise.withResolvers<Response>();
  let session!: ProjectAccessSession;
  let current = access;
  const Capture = () => { session = useProjectAccess(projectId).session; return null; };
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith("/access")) return Promise.resolve(json(current));
    if (url.includes("/deletion-preview")) return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectAccessBoundary projectId={projectId} initialRead><Capture /><Harness /></ProjectAccessBoundary>);
  const button = await screen.findByRole("button", { name: "Delete project" });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("/deletion-preview"))).toBe(true));
  current = { ...access, teamRole: "member", canTransfer: false } as typeof access;
  await act(async () => { await session.revalidate(); });
  await act(async () => pending.resolve(json(preview)));
  expect(screen.queryByText("https://example.com/repo")).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm deletion" })).toBeDisabled();
  expect(fetcher.mock.calls.some(([url]) => url === `/api/v1/projects/${projectId}`)).toBe(false);
});

it("does not withdraw a freshly authorized generation when an older deletion receipt arrives", async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const signal = scope.signal, task = detailFixture(projectId, "00000000-0000-4000-8000-000000000099");
  const sync = taskSyncFromGraph(graphFixture([task]), { actorAccess: access, versionForTask: () => task.version, propertiesForTask: () => task.properties });
  const apply = async () => { const ticket = await scope.beginSync(projectId, signal); await scope.applySync(ticket, sync, signal); };
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (url === `/api/v1/projects/${projectId}` && init?.method === "DELETE") return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  const complete = vi.fn<(receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">) => void>();
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={complete} /></ProjectAccessBoundary>; };
  vi.stubGlobal("fetch", fetcher);
  try {
    await apply(); render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const prior = await scope.beginSync(projectId, signal);
    await act(async () => { await scope.revokeProject(prior, signal); await apply(); });
    const fresh = scope.getAuthorizedProject(projectId);
    expect(fresh).not.toBeNull();
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await act(async () => { await complete.mock.calls[0]![1](); });
    expect(scope.getAuthorizedProject(projectId)).toBe(fresh);
  } finally { scope.dispose(); }
});

it("keeps the current route and does not refresh when an old deletion cannot revoke the newer generation", async () => {
  browserNavigation().dispose(); window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const revoke = vi.spyOn(scope, "revokeProject").mockResolvedValue(false);
  const refresh = vi.fn();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return Promise.resolve(json({ projectId, deleted: true }));
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => {
    const guard = useProjectManagementGuard(), navigation = useDeletionNavigation(scope, refresh);
    return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={navigation.complete} /><DeletionResultNotices state={navigation} /></ProjectAccessBoundary>;
  };
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    expect(await screen.findByText(/Project deleted/)).toBeVisible();
    await screen.findByRole("button", { name: "Dismiss" });
    expect(revoke).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(`/projects/${projectId}/settings`);
    expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible();
  } finally { scope.dispose(); browserNavigation().dispose(); }
});

it.each([
  ["deletion", "original"], ["deletion", "new generation"],
  ["background", "original"], ["background", "new generation"],
] as const)("retries %s cleanup failure with %s state", async (source, generation) => {
  browserNavigation().dispose(); window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }), signal = scope.signal;
  const taskId = "00000000-0000-4000-8000-000000000099";
  const task = detailFixture(projectId, taskId);
  const sync = taskSyncFromGraph(graphFixture([task]), { actorAccess: access, versionForTask: () => task.version, propertiesForTask: () => task.properties });
  const apply = async () => { const ticket = await scope.beginSync(projectId, signal); await scope.applySync(ticket, sync, signal); };
  const pending = Promise.withResolvers<Response>();
  const cleanupGate = Promise.withResolvers<void>();
  const ready = scope.ready.bind(scope); let blockNextReady = false, cleanupWaiting = false;
  vi.spyOn(scope, "ready").mockImplementation(async (readySignal) => {
    if (blockNextReady) { blockNextReady = false; cleanupWaiting = true; await cleanupGate.promise; }
    await ready(readySignal);
  });
  const revoke = vi.spyOn(scope, "revokeProject"), retry = vi.spyOn(scope, "retryDeniedProjectCleanup"), refresh = vi.fn();
  const events: unknown[] = [];
  const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) events.push(event); });
  const put = IDBObjectStore.prototype.put;
  let injectFailure = false, failures = 0;
  const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (injectFailure && this.name === "projects" && (args[0] as { state?: string }).state === "invalidated") {
      injectFailure = false; failures++; throw new DOMException("Injected cleanup failure", "QuotaExceededError");
    }
    return put.apply(this, args);
  });
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (init?.method === "DELETE") return pending.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  let session!: ProjectAccessSession;
  const CaptureAccess = () => { session = useProjectAccess(projectId).session; return null; };
  const Subject = () => {
    const guard = useProjectManagementGuard(), navigation = useDeletionNavigation(scope, refresh);
    return <ProjectAccessBoundary projectId={projectId} initialRead><CaptureAccess /><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onDeleted={navigation.complete} /><DeletionResultNotices state={navigation} /></ProjectAccessBoundary>;
  };
  vi.stubGlobal("fetch", fetcher);
  await apply();
  const backgroundTicket = await scope.beginSync(projectId, signal);
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    injectFailure = true;
    let background: Promise<unknown> | null = null;
    if (source === "background") {
      blockNextReady = true;
      act(() => { background = scope.revokeProject(backgroundTicket, signal).catch((error: unknown) => error); });
      await waitFor(() => expect(cleanupWaiting).toBe(true));
    }
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    if (source === "background") {
      await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
      const deleteTicket = revoke.mock.calls[1]![0];
      expect(deleteTicket).not.toBe(backgroundTicket);
      expect(deleteTicket).toMatchObject({ userId: backgroundTicket.userId, userFence: backgroundTicket.userFence, projectId, cacheGeneration: backgroundTicket.cacheGeneration });
      await act(async () => { cleanupGate.resolve(); await background; });
    }
    expect(await screen.findByText("Deletion succeeded, but local cache cleanup failed.")).toBeVisible();
    expect(screen.getByText(/Project deleted/)).toBeVisible(); expect(failures).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await db.get("projects", [userId, projectId]))?.state).toBe("active");
    expect(await db.get("summaries", [userId, projectId, taskId])).toBeDefined();
    let fresh: ReturnType<typeof scope.getAuthorizedProject> = null, input: HTMLElement | null = null;
    if (generation === "new generation") {
      await act(async () => { await apply(); await session.revalidateAfterMutation(); });
      fresh = scope.getAuthorizedProject(projectId); expect(fresh).not.toBeNull();
      const reopened = await open();
      input = within(reopened).getByLabelText("Enter the project name to confirm");
      fireEvent.change(input, { target: { value: "new input" } });
    }
    const eventCount = events.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await screen.findByRole("button", { name: "Dismiss" });
    expect(screen.queryByText("Deletion succeeded, but local cache cleanup failed.")).toBeNull();
    expect(screen.getByText(/Project deleted/)).toBeVisible();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(revoke).toHaveBeenCalledTimes(source === "background" ? 2 : 1); expect(retry).toHaveBeenCalledOnce(); expect(events).toHaveLength(eventCount);
    if (generation === "original") {
      expect((await db.get("projects", [userId, projectId]))?.state).toBe("invalidated");
      expect(await db.get("summaries", [userId, projectId, taskId])).toBeUndefined();
    } else {
      expect(scope.getAuthorizedProject(projectId)).toBe(fresh);
      expect((await db.get("projects", [userId, projectId]))?.state).toBe("active");
      expect(await db.get("summaries", [userId, projectId, taskId])).toBeDefined();
      expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible(); expect(input).toHaveValue("new input");
    }
  } finally { cleanupGate.resolve(); db.close(); fault.mockRestore(); unsubscribe(); scope.dispose(); browserNavigation().dispose(); }
});

it("shows a retained settings link as unavailable when the Project is gone", async () => {
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const personal = { id: access.ownerTeam.id, kind: "personal" as const, name: null };
  const user = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: personal };
  const missing = () => json({ error: { code: "not_found", message: "Missing", requestId: "missing-project" } }, 404);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url === `/api/v1/teams/${personal.id}`) return Promise.resolve(json(personalTeamPage(userId).items[0]));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}` || url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(missing());
    throw new Error(`Unexpected request: ${url}`);
  }));
  createLocaleRender("en")(<AuthenticatedApp />);
  expect((await screen.findAllByText("Project not found or access unavailable.")).length).toBeGreaterThan(0);
  expect(screen.queryByLabelText("Alert threshold")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
});


it.each(['ordinary', 'unknown-dialog', 'unknown-callback'] as const)('does not withdraw a newer Project observation for an old %s preview 404', async mode => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000005')]);
  const seed = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(seed, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  const old = Promise.withResolvers<Response>();
  let previews = 0, session!: ProjectAccessSession;
  let check: (() => Promise<'available' | 'unavailable'>) | undefined;
  const Capture = () => { session = useProjectAccess(projectId).session; return null; };
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><Capture /><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onOutcome={(_kind, _error, retry) => { check = retry; }} /></ProjectAccessBoundary>; };
  const fetcher = vi.fn((url: string, init: RequestInit = {}) => {
    if (url.endsWith('/access')) return Promise.resolve(json(access));
    if (url.includes('/deletion-preview')) { previews++; return mode === 'ordinary' || previews > 1 ? old.promise : Promise.resolve(json(preview)); }
    if (url === `/api/v1/projects/${projectId}` && init.method === 'DELETE') return Promise.reject(new TypeError('lost response'));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(graph.project));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const revoke = vi.spyOn(scope, 'revokeProject');
  try {
    render(<Subject />, { taskCache: { scope } });
    const button = await screen.findByRole('button', { name: 'Delete project' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Delete this project?' });
    if (mode !== 'ordinary') {
      await within(dialog).findByText('https://example.com/repo'); confirm(dialog);
      await within(dialog).findByRole('alert');
      await waitFor(() => expect(check).toBeDefined());
      if (mode === 'unknown-dialog') fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    }
    let checked: Promise<'available' | 'unavailable'> | undefined;
    if (mode === 'unknown-callback') { checked = check!(); void checked.catch(() => {}); }
    await waitFor(() => expect(previews).toBe(mode === 'ordinary' ? 1 : 2));
    const ticket = session.beginObservation();
    await getProject(projectId, scope.signal, { userId, onPrincipalMismatch: scope.principalMismatch });
    expect(session.publishProjectRead(ticket)).toBe(true);
    await act(async () => old.resolve(json({ error: { code: 'not_found', message: 'Missing', requestId: 'old-preview' } }, 404)));
    if (checked !== undefined) await expect(checked).rejects.toThrow('Project observation changed');
    else await within(dialog).findByText('Unable to load the deletion preview.');
    expect(revoke).not.toHaveBeenCalled();
    expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
  } finally { scope.dispose(); }
});

it.each(['ordinary', 'unknown-dialog', 'unknown-callback'] as const)('accepts a slow %s preview after a newer positive task sync', async mode => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000005')]);
  const seed = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(seed, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  const slow = Promise.withResolvers<Response>(); let previews = 0, session!: ProjectAccessSession;
  let check: (() => Promise<'available' | 'unavailable'>) | undefined;
  const Capture = () => { session = useProjectAccess(projectId).session; return null; };
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><Capture /><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onOutcome={(_kind, _error, retry) => { check = retry; }} /></ProjectAccessBoundary>; };
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    if (url.endsWith('/access')) return Promise.resolve(json(access));
    if (url.includes('/deletion-preview')) { previews++; return mode === 'ordinary' || previews > 1 ? slow.promise : Promise.resolve(json(preview)); }
    if (url === `/api/v1/projects/${projectId}` && init.method === 'DELETE') return Promise.reject(new TypeError('lost response'));
    throw new Error(`Unexpected request: ${url}`);
  }));
  try {
    render(<Subject />, { taskCache: { scope } });
    const button = await screen.findByRole('button', { name: 'Delete project' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Delete this project?' });
    if (mode !== 'ordinary') {
      await within(dialog).findByText('https://example.com/repo'); confirm(dialog);
      await within(dialog).findByRole('alert'); await waitFor(() => expect(check).toBeDefined());
      if (mode === 'unknown-dialog') fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    }
    const checked = mode === 'unknown-callback' ? check!() : undefined;
    await waitFor(() => expect(previews).toBe(mode === 'ordinary' ? 1 : 2));
    const ticket = await scope.beginSync(projectId, scope.signal);
    const observation = session.beginObservation();
    await scope.applySync(ticket, taskSyncFromGraph(graph, { query: { epoch: ticket.epoch! }, versionForTask: () => 1n }), scope.signal);
    expect(session.publishSync(observation, access)).toBe(true);
    await act(async () => slow.resolve(json(preview)));
    if (checked !== undefined) await expect(checked).resolves.toBe('available');
    else if (mode === 'unknown-dialog') expect(await within(dialog).findByText(/project is currently accessible/i)).toBeVisible();
    else expect(await within(dialog).findByText('https://example.com/repo')).toBeVisible();
  } finally { scope.dispose(); }
});

it.each(['dialog', 'callback'] as const)('rejects a pending unknown-outcome %s check after an independent withdrawal', async mode => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000005')]);
  const seed = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(seed, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  const slow = Promise.withResolvers<Response>(); let previews = 0;
  let check: (() => Promise<'available' | 'unavailable'>) | undefined;
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} onOutcome={(_kind, _error, retry) => { check = retry; }} /></ProjectAccessBoundary>; };
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    if (url.endsWith('/access')) return Promise.resolve(json(access));
    if (url.includes('/deletion-preview')) return ++previews === 1 ? Promise.resolve(json(preview)) : slow.promise;
    if (init.method === 'DELETE') return Promise.reject(new TypeError('lost response'));
    throw new Error(`Unexpected request: ${url}`);
  }));
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog); await waitFor(() => expect(check).toBeDefined());
    let checked: Promise<'available' | 'unavailable'> | undefined;
    if (mode === 'callback') { checked = check!(); void checked.catch(() => {}); }
    else fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    await waitFor(() => expect(previews).toBe(2));
    const ticket = await scope.beginSync(projectId, scope.signal);
    await act(async () => { await scope.revokeProject(ticket, scope.signal); });
    await act(async () => slow.resolve(json(preview)));
    if (checked !== undefined) await expect(checked).rejects.toThrow('Project observation changed');
    else {
      expect(within(dialog).queryByText(/project is currently accessible/i)).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Check current state' })).toBeEnabled();
    }
  } finally { scope.dispose(); }
});

it('does not withdraw a newer Project observation for an old rejected DELETE 404', async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000005')]);
  const seed = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(seed, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  const pending = Promise.withResolvers<Response>(); let requestId = ''; let session!: ProjectAccessSession;
  const Capture = () => { session = useProjectAccess(projectId).session; return null; };
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><Capture /><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} /></ProjectAccessBoundary>; };
  const fetcher = vi.fn((url: string, init: RequestInit = {}) => {
    if (url.endsWith('/access')) return Promise.resolve(json(access));
    if (url.includes('/deletion-preview')) return Promise.resolve(json(preview));
    if (init.method === 'DELETE') { requestId = new Headers(init.headers).get('X-Request-ID')!; return pending.promise; }
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(graph.project));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher); const revoke = vi.spyOn(scope, 'revokeProject');
  try {
    render(<Subject />, { taskCache: { scope } });
    const dialog = await open(); confirm(dialog);
    await waitFor(() => expect(requestId).not.toBe(''));
    const observation = session.beginObservation();
    await getProject(projectId, scope.signal, { userId, onPrincipalMismatch: scope.principalMismatch });
    expect(session.publishProjectRead(observation)).toBe(true);
    await act(async () => pending.resolve(json({ error: { code: 'not_found', message: 'Missing', requestId } }, 404, { 'X-Request-ID': requestId })));
    await within(dialog).findByText(/Deletion was not committed/);
    expect(revoke).not.toHaveBeenCalled();
    expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
  } finally { scope.dispose(); }
});


it('keeps an accepted deletion preview when an older Project read returns 404', async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000005')]);
  const seed = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(seed, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  const old = Promise.withResolvers<Response>(); let projectReads = 0;
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith('/access')) return Promise.resolve(json(access));
    if (url.includes('/deletion-preview')) return Promise.resolve(json(preview));
    if (url.endsWith('/task-sync')) return new Promise<Response>(() => {});
    if (url === `/api/v1/projects/${projectId}`) return ++projectReads === 1 ? old.promise : Promise.resolve(json(graph.project));
    throw new Error(`Unexpected request: ${url}`);
  });
  const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectPage projectId={projectId} /><ProjectDeletion projectId={projectId} active onRoute unavailable={false} guard={guard} /></ProjectAccessBoundary>; };
  vi.stubGlobal('fetch', fetcher);
  const revoke = vi.spyOn(scope, 'revokeProject');
  try {
    render(<Subject />, { taskCache: { scope } });
    await waitFor(() => expect(projectReads).toBe(1));
    const dialog = await open();
    await act(async () => old.resolve(json({ error: { code: 'not_found', message: 'Missing', requestId: 'old-project' } }, 404)));
    await waitFor(() => expect(projectReads).toBeGreaterThan(1));
    expect(within(dialog).getByText('https://example.com/repo')).toBeVisible();
    expect(revoke).not.toHaveBeenCalled();
    expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
  } finally { scope.dispose(); }
});

it("retains deletion confirmation after leaving and returning to its section", async () => {
  browserNavigation().dispose(); window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const revoke = vi.spyOn(scope, "revokeProject").mockResolvedValue(true);
  const write = Promise.withResolvers<Response>();
  const complete = vi.fn<(receipt: ProjectDeletionReceipt, finish: (signal?: AbortSignal) => Promise<void | "skipped">, location: unknown, canFinalize: () => boolean) => void>(), observe = vi.fn();
  const fetcher = vi.fn((url: string, init: RequestInit = {}) => {
    if (url.endsWith("/access")) return Promise.resolve(json(access));
    if (url.includes("/deletion-preview")) return Promise.resolve(json(preview));
    if (url === `/api/v1/projects/${projectId}` && init.method === "DELETE") return write.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const Subject = ({ active, generation }: { active: boolean; generation: number }) => {
    const guard = useProjectManagementGuard();
    return <ProjectAccessBoundary projectId={projectId} initialRead><ProjectDeletion projectId={projectId} active={active} onRoute unavailable={false} guard={guard} presentationGeneration={generation} onStateChange={observe} onDeleted={complete} /></ProjectAccessBoundary>;
  };
  const view = render(<Subject active generation={0} />, { taskCache: { scope } });
  const dialog = await open();
  expect(observe).toHaveBeenLastCalledWith({ dirty: false, pending: false, needsAttention: false });
  confirm(dialog);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1));
  expect(observe).toHaveBeenLastCalledWith({ dirty: true, pending: true, needsAttention: false });
  view.rerender(<Subject active={false} generation={1} />); view.rerender(<Subject active generation={1} />);
  await act(async () => write.resolve(json({ projectId, deleted: true })));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(complete.mock.calls[0]![3]()).toBe(false);
  await act(async () => { await complete.mock.calls[0]![1](); });
  expect(revoke).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible();
  scope.dispose();
});
