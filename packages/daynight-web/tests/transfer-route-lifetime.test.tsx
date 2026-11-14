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
  window.history.replaceState(null, "", `/projects/${projectId}/settings?tab=management`);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

it.each(["original page", "Back to original page"] as const)("keeps receipt navigation bound to the submitted location: %s", async (scenario) => {
  const pending = Promise.withResolvers<Response>();
  const team = personalTeamPage(userId).items[0]!;
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url === `/api/v1/teams/${source}`) return Promise.resolve(json(team));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/transfer`) return pending.promise;
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }, { timeout: 10000 }));
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1));
  if (scenario === "Back to original page") {
    act(() => navigate("/workers"));
    expect(window.location.pathname).toBe("/workers");
    await act(async () => { await new Promise<void>((resolve) => { window.addEventListener("popstate", () => resolve(), { once: true }); window.history.back(); }); });
    expect(window.location.pathname).toBe(`/projects/${projectId}/settings`);
    expect(screen.getByRole("dialog", { name: "Transfer project" })).toBe(dialog);
  }
  await act(async () => pending.resolve(json({ projectId, changed: true, sourceTeam: personal, ownerTeam: targetTeam, ownership: { teamId: target, version: 2n }, actorAccess: null })));
  const receipt = await screen.findByText(/Project transferred to Destination/);
  expect(receipt).toHaveTextContent("You no longer have access to this project");
  if (scenario === "original page") await waitFor(() => expect(window.location.pathname).toBe(`/teams/${source}`));
  else {
    expect(await screen.findByRole("link", { name: "Go to Team projects" })).toHaveAttribute("href", `/teams/${source}`);
    expect(window.location.pathname).toBe(`/projects/${projectId}/settings`);
  }
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
}, 20000);

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
  act(() => navigate(`/projects/${projectId}/settings?tab=management`));
  const reopened = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(within(reopened).getByRole("alert")).toHaveTextContent("transfer result is unknown");
  expect(within(reopened).queryByRole("button", { name: "Confirm transfer" })).toBeNull();
  expect(within(reopened).getByRole("button", { name: "Close" })).toBeEnabled();
  fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Transfer project" })).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(1);
});

it("keeps settings writes blocked across navigation while a transfer outcome is unknown", async () => {
  const transfer = Promise.withResolvers<Response>(), permission = Promise.withResolvers<Response>();
  let holdPermission = false;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return holdPermission ? permission.promise : Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/transfer`) return transfer.promise;
    if (url === `/api/v1/projects/${projectId}/settings` && init?.method === "PATCH") return Promise.resolve(json({ ...project, settings: { version: 2n, executionWarningMinutes: 90 } }));
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/transfer"))).toBe(true));
  await act(async () => transfer.reject(new Error("lost transfer")));
  expect(await within(dialog).findByText(/transfer result is unknown/i)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  act(() => navigate(`/projects/${projectId}/settings`));
  const field = screen.getByLabelText("Alert threshold"); fireEvent.change(field, { target: { value: "90" } });
  const priorReads = fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
  holdPermission = true; fireEvent(window, new Event("focus"));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(priorReads));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("button", { name: "Save settings" }).closest("form")!);
  act(() => navigate("/workers"));
  holdPermission = false;
  act(() => navigate(`/projects/${projectId}/settings`));
  await act(async () => permission.resolve(json(access)));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  act(() => navigate(`/projects/${projectId}/settings?tab=management`));
  expect(screen.getByText(/transfer result is unknown/i)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith("/settings") && init?.method === "PATCH")).toHaveLength(0);
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
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
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
  act(() => navigate(`/projects/${projectId}/settings?tab=management`));
  const reopened = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(within(reopened).getByRole("alert")).toHaveTextContent("request-denied");
  expect(within(reopened).getByRole("button", { name: "Cancel" })).toBeEnabled();
  fireEvent.click(within(reopened).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Transfer project" })).toBeNull();
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
  act(() => navigate(`/projects/${projectId}/settings?tab=management`));
  const reopened = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(within(reopened).getByRole("alert")).toHaveTextContent("transfer result is unknown");
  fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
  act(() => navigate(`/projects/${projectId}/members`));
  expect(await screen.findByText(/invitation change was not confirmed/i)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/transfer'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith('/invitations') && init?.method === 'POST')).toHaveLength(1);
});

it.each(["success", "error", "changed"] as const)("retains the transfer editor and rejects an old %s preview after an account change", async (outcome) => {
  const preview = Promise.withResolvers<Response>();
  const otherUser = "00000000-0000-4000-8000-000000000099";
  let meReads = 0, previewSignal: AbortSignal | undefined;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/v1/me") { meReads++; return Promise.resolve(json(user)); }
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) { previewSignal = init?.signal as AbortSignal; return preview.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  const input = within(dialog).getByLabelText("Team ID or link");
  fireEvent.change(input, { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(previewSignal).toBeDefined());
  const body = outcome === "error" ? { error: { code: "internal_error", message: "private", requestId: "preview-error" } } : { sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null };
  if (outcome !== "changed") {
    act(() => { window.localStorage.setItem("daynight.activeUser", JSON.stringify(otherUser)); window.dispatchEvent(new StorageEvent("storage", { key: "daynight.activeUser" })); });
    expect(previewSignal!.aborted).toBe(true);
  }
  const result = outcome === "changed" ? new Response(stringifyWireJson(body), { headers: viewerHeaders(otherUser, { "Content-Type": "application/json" }) }) : json(body, outcome === "error" ? 503 : 200);
  await act(async () => { preview.resolve(result); await preview.promise; });
  expect(await within(dialog).findByText("Account changed")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Transfer project" })).toBe(dialog);
  expect(input).toHaveValue(target);
  expect(within(dialog).queryByText("After transfer")).toBeNull();
  expect(within(dialog).queryByText(/preview-error/)).toBeNull();
  fireEvent.change(input, { target: { value: target + "?draft" } });
  expect(input).toHaveValue(target + "?draft");
  expect(meReads).toBe(1);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer-preview"))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer"))).toHaveLength(0);
});

it("retains Team choices across focus and account change without rereading", async () => {
  let reads = 0, meReads = 0;
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") { meReads++; return Promise.resolve(json(user)); }
    if (url.startsWith("/api/v1/teams?")) { reads++; return Promise.resolve(json(personalTeamPage(userId))); }
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }));
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  const select = within(dialog).getByLabelText("Your Teams");
  await within(select).findByRole("option", { name: "Personal · admin" });
  fireEvent.change(select, { target: { value: source } });
  const before = reads;
  vi.mocked(document.hasFocus).mockReturnValue(false); fireEvent(window, new Event("blur")); vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent(window, new Event("focus"));
  expect(reads).toBe(before); expect(meReads).toBe(1);
  act(() => { window.localStorage.setItem("daynight.activeUser", JSON.stringify("00000000-0000-4000-8000-000000000099")); window.dispatchEvent(new StorageEvent("storage", { key: "daynight.activeUser" })); });
  expect(await within(dialog).findByText("Account changed")).toBeVisible();
  expect(select).toHaveValue(source); expect(within(select).getByRole("option", { name: "Personal · admin" })).toBeInTheDocument();
  expect(reads).toBe(before); expect(meReads).toBe(1);
});

it("does not redirect a replacement settings owner when the old source lookup finishes", async () => {
  const sourceRead = Promise.withResolvers<Response>();
  const team = personalTeamPage(userId).items[0]!;
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url === `/api/v1/teams/${source}`) return sourceRead.promise;
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(json(access));
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/transfer`) return Promise.resolve(json({ projectId, changed: true, sourceTeam: personal, ownerTeam: targetTeam, ownership: { teamId: target, version: 2n }, actorAccess: null }));
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }, { timeout: 10000 }));
  const originalOwner = screen.getByRole("navigation", { name: "Project settings" }).parentElement!;
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === `/api/v1/teams/${source}`)).toBe(true), { timeout: 10000 });
  expect(await screen.findByText(/Project transferred to Destination/)).toBeInTheDocument();
  act(() => navigate("/workers"));
  await waitFor(() => expect(originalOwner.isConnected).toBe(false));
  act(() => navigate(`/projects/${projectId}/settings?tab=management`));
  await waitFor(() => expect(window.location.pathname).toBe(`/projects/${projectId}/settings`));
  await act(async () => sourceRead.resolve(json(team)));
  expect(await screen.findByRole("link", { name: "Go to Team projects" })).toHaveAttribute("href", `/teams/${source}`);
  expect(window.location.pathname).toBe(`/projects/${projectId}/settings`);
}, 20000);

it("retains a newer transfer draft across a second route change while old cleanup finishes", async () => {
  const cleanupAccess = Promise.withResolvers<Response>();
  const laterTarget = "00000000-0000-4000-8000-000000000703";
  const ownership = { teamId: target, version: 2n };
  const transferredAccess = { ...access, ownerTeam: targetTeam, ownership };
  let afterTransfer = false, cleanupStarted = false;
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/v1/me") return Promise.resolve(json(user));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json(personalTeamPage(userId)));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(json(project));
    if (url === `/api/v1/projects/${projectId}/access`) {
      if (afterTransfer) { cleanupStarted = true; return cleanupAccess.promise; }
      return Promise.resolve(json(access));
    }
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...targetTeam, version: 1n }, ownership: project.ownership, actorRole: "admin" }));
    if (url === `/api/v1/projects/${projectId}/transfer`) { afterTransfer = true; return Promise.resolve(json({ projectId, changed: true, sourceTeam: personal, ownerTeam: targetTeam, ownership, actorAccess: transferredAccess })); }
    if (url.startsWith("/api/v1/workers")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer project" }, { timeout: 10000 }));
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  const input = within(dialog).getByLabelText("Team ID or link");
  fireEvent.change(input, { target: { value: target } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  const confirm = within(dialog).getByRole("button", { name: "Confirm transfer" });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  await waitFor(() => expect(cleanupStarted).toBe(true), { timeout: 10000 });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: laterTarget } });
  act(() => navigate("/workers"));
  await act(async () => cleanupAccess.resolve(json(transferredAccess)));
  expect(await screen.findByText(/Project transferred to Destination/)).toBeInTheDocument();
  act(() => navigate(`/projects/${projectId}/settings?tab=management`));
  expect(await screen.findByRole("dialog", { name: "Transfer project" })).toBe(dialog);
  expect(within(dialog).getByLabelText("Team ID or link")).toHaveValue(laterTarget);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Transfer project" })).toBeNull();
}, 20000);
