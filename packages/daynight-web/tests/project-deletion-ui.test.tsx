import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import type { ProjectAccess } from "../src/api/auth-types";
import type { ProjectDeletionReceipt } from "../src/api/project-deletion";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { browserNavigation } from "../src/app/navigation";
import { ProjectDeletion } from "../src/features/management/ProjectDeletion";
import { DeletionResultNotices, useDeletionNavigation } from "../src/features/management/deletion-navigation";
import { useProjectManagementGuard } from "../src/features/management/ProjectManagementGuard";
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from "../src/features/projects/ProjectAccess";
import { createTaskCacheScope } from "../src/features/task-cache/project-cache";
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
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const input = within(dialog).getByLabelText("Enter the project name to confirm");
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "new input" } });
    await act(async () => { await complete.mock.calls[0]![1](); });
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete this project?" })).toBeVisible();
    expect(input).toHaveValue("new input");
  } finally { scope.dispose(); }
});

it("does not close a reopened dialog when the earlier deletion is finalized", async () => {
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
    const first = await open(); confirm(first);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    await act(async () => pending.resolve(json({ projectId, deleted: true })));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    const second = await open();
    const input = within(second).getByLabelText("Enter the project name to confirm");
    fireEvent.change(input, { target: { value: "new input" } });
    await act(async () => { await complete.mock.calls[0]![1](); });
    expect(revoke).not.toHaveBeenCalled();
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
