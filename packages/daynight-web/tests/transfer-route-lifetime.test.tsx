import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { personalTeamPage } from "./helpers/team";
import { directAccessFixture, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

const userId = "00000000-0000-4000-8000-000000000001", projectId = "00000000-0000-4000-8000-000000000003", source = "00000000-0000-4000-8000-000000000701", target = "00000000-0000-4000-8000-000000000702";
const personal = { id: source, kind: "personal" as const, name: null }, targetTeam = { id: target, kind: "ordinary" as const, name: "Destination" };
const time = "2026-10-22T10:00:00Z";
const access = { ...directAccessFixture(projectId, userId, "admin"), teamRole: "admin", canTransfer: true };
const project = { id: projectId, name: "Project", repoUrl: "https://github.com/example/repo", createdAt: time, updatedAt: time, ownership: { teamId: source, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
const user = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: personal };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: viewerHeaders(userId, { "Content-Type": "application/json" }) });
const render = createLocaleRender("en");
beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

it("retains an unknown transfer across route changes without replaying it", async () => {
  const pending = Promise.withResolvers<Response>();
  let transferSignal: AbortSignal | undefined;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/transfer`) { transferSignal = init?.signal as AbortSignal; return pending.promise; }
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
  await waitFor(() => expect(transferSignal).toBeDefined());
  expect(within(dialog).queryByRole("combobox", { name: "语言 / Language" })).toBeNull();
  view.setLocale("zh-CN");
  expect(screen.getByRole("dialog", { name: "转移项目" })).toBe(dialog);
  expect(within(dialog).getByLabelText("目标 Team ID 或链接")).toHaveValue(target);
  expect(within(dialog).getByRole("button", { name: "正在提交" })).toBeDisabled();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
  view.setLocale("en");
  act(() => navigate("/workers"));
  expect(transferSignal!.aborted).toBe(false);
  await act(async () => pending.reject(new Error("lost response")));
  expect(window.location.pathname).toBe("/workers");
  act(() => navigate(`/projects/${projectId}/settings`));
  const reopened = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(within(reopened).getByRole("alert")).toHaveTextContent("transfer result is unknown");
  expect(within(reopened).queryByRole("button", { name: "Confirm transfer" })).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
});

it("discards an ordinary settings draft when leaving and reloads on return", async () => {
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  const field = await screen.findByLabelText("Alert threshold"); await waitFor(() => expect(field).toBeEnabled());
  fireEvent.change(field, { target: { value: "90" } });
  act(() => navigate("/workers")); act(() => navigate(`/projects/${projectId}/settings`));
  const restored = await screen.findByLabelText("Alert threshold"); await waitFor(() => expect(restored).toHaveValue(60));
  expect(fetcher.mock.calls.filter(([url]) => url === `/api/v1/projects/${projectId}`)).toHaveLength(2);
});

it("retains a definite rejection that arrives after leaving the settings page", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/transfer`) return pending.promise;
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/transfer"))).toBe(true));
  act(() => navigate("/workers"));
  await act(async () => pending.resolve(json({ error: { code: "forbidden", message: "No permission", requestId: "request-denied" } }, 403)));
  expect(window.location.pathname).toBe("/workers");
  act(() => navigate(`/projects/${projectId}/settings`));
  const reopened = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(within(reopened).getByRole("alert")).toHaveTextContent("request-denied");
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
});

it("refreshes the current Team directory when a transfer receipt arrives after changing scope", async () => {
  const pendingTransfer = Promise.withResolvers<Response>();
  const pendingList = Promise.withResolvers<Response>();
  let targetReads = 0;
  let listSignal: AbortSignal | undefined;
  const targetDetails = { ...targetTeam, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: target, userId, role: "member", version: 1n, createdAt: time, updatedAt: time } };
  const targetProject = { ...project, name: "Destination project", ownership: { teamId: target, version: 2n } };
  const transferredAccess = { projectId, ownerTeam: targetTeam, ownership: targetProject.ownership, teamRole: "member", effectiveRole: "member", directGrant: null, canTransfer: false };
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url === `/api/v1/teams/${target}`) return Promise.resolve(json(targetDetails));
    if (url.startsWith("/api/v1/projects?")) {
      if (new URL(url, window.location.origin).searchParams.get("teamId") === target) {
        targetReads++;
        if (targetReads === 1) { listSignal = init?.signal as AbortSignal; return pendingList.promise; }
        return Promise.resolve(json({ items: [targetProject], nextCursor: null }));
      }
      return Promise.resolve(json({ items: [project], nextCursor: null }));
    }
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: "member" }));
    if (url === `/api/v1/projects/${projectId}/transfer`) return pendingTransfer.promise;
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/transfer"))).toBe(true));
  act(() => navigate(`/teams/${target}`));
  await waitFor(() => expect(targetReads).toBe(1));
  await act(async () => pendingTransfer.resolve(json({ projectId, changed: true, sourceTeam: personal, ownerTeam: targetTeam, ownership: targetProject.ownership, actorAccess: transferredAccess })));
  await waitFor(() => expect(targetReads).toBe(2));
  expect(listSignal?.aborted).toBe(true);
  const list = await within(screen.getByRole("main")).findByRole("list", { name: "Project list" });
  expect(within(list).getByRole("link", { name: /Destination project/ })).toBeInTheDocument();
  expect(window.location.pathname).toBe(`/teams/${target}`);
  await act(async () => pendingList.resolve(json({ items: [], nextCursor: null })));
});

it("retains independent unknown transfer and invitation results across their routes", async () => {
  const transferResult = Promise.withResolvers<Response>();
  const invitationResult = Promise.withResolvers<Response>();
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/members`) return Promise.resolve(json({ items: [], actorAccess: access }));
    if (url === `/api/v1/projects/${projectId}/invitations`) return init?.method === 'POST' ? invitationResult.promise : Promise.resolve(json({ items: [] }));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/transfer`) return transferResult.promise;
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('/transfer'))).toBe(true));
  act(() => navigate(`/projects/${projectId}/members`));
  const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
  const inviteDialog = screen.getByRole("dialog", { name: "Invite project member" });
  await waitFor(() => expect(within(inviteDialog).getByRole("button", { name: "Create invitation link" })).toBeEnabled());
  fireEvent.click(within(inviteDialog).getByRole("button", { name: "Create invitation link" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith('/invitations') && init?.method === 'POST')).toHaveLength(1));
  await act(async () => { transferResult.reject(new Error('lost transfer')); invitationResult.reject(new Error('lost invitation')); });
  await screen.findByText(/invitation change was not confirmed/i);
  act(() => navigate(`/projects/${projectId}/settings`));
  const reopened = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(within(reopened).getByRole("alert")).toHaveTextContent("transfer result is unknown");
  fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
  act(() => navigate(`/projects/${projectId}/members`));
  expect(await screen.findByText(/invitation change was not confirmed/i)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/transfer'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith('/invitations') && init?.method === 'POST')).toHaveLength(1);
});

it.each(["success", "error", "changed"] as const)("holds transfer preview %s through pending identity and access checks", async (outcome) => {
  const preview = Promise.withResolvers<Response>(), identity = Promise.withResolvers<Response>(), permission = Promise.withResolvers<Response>();
  let focused = true, meReads = 0, holdPermission = false, permissionReads = 0;
  vi.mocked(document.hasFocus).mockImplementation(() => focused);
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return ++meReads === 1 ? Promise.resolve(json(user)) : identity.promise;
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) { if (holdPermission) { permissionReads++; return permission.promise; } return Promise.resolve(json(access)); }
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return preview.promise;
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/transfer-preview"))).toBe(true));
  holdPermission = true; focused = false; fireEvent(window, new Event("blur")); focused = true; fireEvent(window, new Event("focus"));
  await waitFor(() => expect(meReads).toBe(2));
  const result = outcome === "error" ? json({ error: { code: "internal_error", message: "private", requestId: "preview-error" } }, 503) : json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null });
  await act(async () => preview.resolve(result));
  expect(screen.getByRole("dialog", { name: "Transfer project" })).toBe(dialog);
  expect(within(dialog).queryByText("After transfer")).toBeNull();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  await act(async () => identity.resolve(json(outcome === "changed" ? { ...user, id: "00000000-0000-4000-8000-000000000099" } : user)));
  if (outcome === "changed") {
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(screen.queryByText("After transfer")).toBeNull();
    return;
  }
  if (outcome === "success") {
    await waitFor(() => expect(permissionReads).toBeGreaterThan(0));
    expect(within(dialog).queryByText("After transfer")).toBeNull();
    await act(async () => permission.resolve(json(access)));
    await within(dialog).findByText("After transfer");
  } else {
    await within(dialog).findByText(/preview-error/);
    await act(async () => permission.resolve(json(access)));
  }
});

it("retains transfer choices and permits retry when a background Team reread fails", async () => {
  let reads = 0;
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(++reads === 2 ? json({ error: { code: "internal_error", message: "private", requestId: "rq-team" } }, 500) : json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }, { timeout: 20000 }));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" }, { timeout: 20000 });
  const select = within(dialog).getByLabelText("Your Teams");
  await within(select).findByRole("option", { name: "Personal · admin" }, { timeout: 20000 });
  fireEvent.change(select, { target: { value: source } });
  vi.mocked(document.hasFocus).mockReturnValue(false); fireEvent(window, new Event("blur")); vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent(window, new Event("focus"));
  expect(await within(dialog).findByRole("alert", {}, { timeout: 20000 })).toHaveTextContent("Unable to load your Teams");
  expect(select).toHaveValue(source); expect(within(select).getByRole("option", { name: "Personal · admin" })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull(), { timeout: 20000 });
  expect(select).toHaveValue(source); expect(reads).toBe(3);
});
