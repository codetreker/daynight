import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { stringifyWireJson } from "./helpers/wireJson";

const render = createLocaleRender("en");
const userId = "00000000-0000-4000-8000-000000000001", personal = "00000000-0000-4000-8000-000000000002", teamId = "00000000-0000-4000-8000-000000000003", otherId = "00000000-0000-4000-8000-000000000004";
const time = "2026-10-20T09:00:00Z";
const general = `/teams/${teamId}/settings`, members = `/teams/${teamId}/members`;
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const profile = { id: userId, personalTeam: { id: personal, kind: "personal", name: null }, name: "Alice", email: null, emailVerified: null, avatarUrl: null };
const team = (name = "Alpha", role = "admin") => ({ id: teamId, kind: "ordinary", name, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId, role, version: 1n, createdAt: time, updatedAt: time } });
const roster = (role = "admin") => ({ items: [{ ...team("Alpha", role).membership, profile: { name: "Alice", email: null, avatarUrl: null } }, { ...team().membership, userId: otherId, profile: { name: "Bob", email: null, avatarUrl: null } }] });
const install = (extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const special = extra?.(url, init); if (special !== undefined) return Promise.resolve(special);
    if (url === "/api/v1/me") return Promise.resolve(json(profile));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(json({ items: [team()], nextCursor: null }));
    if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(json(team()));
    if (url === `/api/v1/teams/${teamId}/members`) return Promise.resolve(json(roster()));
    if (url === `/api/v1/teams/${teamId}/invitations`) return Promise.resolve(json({ items: [] }));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(json({ items: [], nextCursor: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
};
const openRename = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit Team name" });
  fireEvent.change(within(dialog).getByLabelText("Team name"), { target: { value: "Unsaved name" } });
  return dialog;
};
const go = (path: string) => act(() => navigate(path));
beforeEach(() => { window.history.replaceState(null, "", general); });

describe("Team settings workspace", () => {
  it("uses one settings entry and only loads visited sections while preserving native links", async () => {
    const fetcher = install(); render(<AuthenticatedApp />);
    await screen.findByRole("button", { name: "Edit" });
    const sidebar = document.querySelector(".sidebar nav")! as HTMLElement;
    const settings = within(sidebar).getByRole("link", { name: "Team settings" });
    expect(settings).toHaveAttribute("href", general); expect(settings).toHaveAttribute("aria-current", "page");
    expect(within(sidebar).queryByRole("link", { name: "Team members" })).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/members"))).toBe(false);
    const link = screen.getByRole("link", { name: "Members & invitations" });
    expect(link).toHaveAttribute("href", members);
    fireEvent.click(link, { ctrlKey: true }); expect(window.location.pathname).toBe(general);
    fireEvent.click(link); await screen.findByRole("button", { name: "Leave Team" });
    expect(window.location.pathname).toBe(members);
    expect(screen.getByRole("heading", { level: 1, name: "Team settings" })).toBeVisible();
    expect(document.title).toBe("Team settings · Daynight");
    expect(link).toHaveAttribute("aria-current", "page"); expect(settings).toHaveAttribute("aria-current", "page");
    fireEvent.click(settings); await screen.findByRole("button", { name: "Edit" });
    expect(window.location.pathname).toBe(general);
    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  });

  it("retains the General editor and an unsent member confirmation across section changes", async () => {
    install(); render(<AuthenticatedApp />);
    const editor = await openRename();
    go(members); await screen.findByRole("button", { name: "Leave Team" });
    expect(editor).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove member" });
    go(general);
    await waitFor(() => expect(editor).toBeVisible());
    expect(within(editor).getByLabelText("Team name")).toHaveValue("Unsaved name");
    expect(confirmation).not.toBeVisible();
    go(members); await waitFor(() => expect(confirmation).toBeVisible());
    expect(screen.getByRole("dialog", { name: "Remove member" })).toBe(confirmation);
  });

  it("retains unknown rename outcomes across sections without replaying the write", async () => {
    const fetcher = install((url, init) => url === `/api/v1/teams/${teamId}` && init?.method === "PATCH" ? Promise.reject(new TypeError("Connection lost")) : undefined);
    render(<AuthenticatedApp />); const editor = await openRename();
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("unknown");
    go(members); await screen.findByRole("button", { name: "Leave Team" });
    expect(editor).not.toBeVisible();
    go(general); await waitFor(() => expect(editor).toBeVisible());
    expect(within(editor).getByRole("alert")).toHaveTextContent("unknown");
    expect(within(editor).queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("keeps form and field ownership distinct when another Team has an unknown rename", async () => {
    const beta = "00000000-0000-4000-8000-000000000006";
    const fetcher = install((url, init) => {
      if (url === `/api/v1/teams/${teamId}` && init?.method === "PATCH") return Promise.reject(new TypeError("Connection lost"));
      if (url === `/api/v1/teams/${beta}`) return json({ ...team("Beta"), id: beta, membership: { ...team().membership, teamId: beta } });
      return undefined;
    });
    render(<AuthenticatedApp />); const oldEditor = await openRename();
    fireEvent.click(within(oldEditor).getByRole("button", { name: "Save changes" }));
    expect(await within(oldEditor).findByRole("alert")).toHaveTextContent("unknown");
    go(`/teams/${beta}/settings`); const currentEditor = await openRename();
    const oldInput = within(oldEditor).getByLabelText("Team name");
    const currentInput = within(currentEditor).getByLabelText("Team name");
    expect(currentInput).not.toBe(oldInput); expect(currentInput.id).not.toBe(oldInput.id);
    expect(currentInput).toBeVisible(); expect(oldInput).not.toBeVisible();
    const currentForm = currentEditor.querySelector("form")!;
    expect(currentForm.id).not.toBe(oldEditor.querySelector("form")!.id);
    expect(within(currentEditor).getByRole("button", { name: "Save changes" })).toHaveAttribute("form", currentForm.id);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each([members, "/shared-projects"])("keeps a late rename completion on %s and preserves its current focus", async (destination) => {
    const receipt = Promise.withResolvers<Response>();
    const fetcher = install((url, init) => url === `/api/v1/teams/${teamId}` && init?.method === "PATCH" ? receipt.promise : undefined);
    render(<AuthenticatedApp />); const editor = await openRename();
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    go(destination);
    if (destination === members) await screen.findByRole("button", { name: "Leave Team" });
    else await screen.findByRole("heading", { name: "Projects shared with me" });
    const link = screen.getByRole("link", { name: "Shared with me" }); link.focus();
    await act(async () => receipt.resolve(json({ ...team("Unsaved name"), version: 2n })));
    await screen.findByText("Team name saved.");
    if (destination === members) {
      expect(screen.getByRole("dialog", { name: "Edit Team name", hidden: true })).toBe(editor);
      expect(within(editor).getByLabelText("Team name")).toHaveValue("Unsaved name");
    } else await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Team name", hidden: true })).toBeNull());
    expect(window.location.pathname).toBe(destination); expect(link).toHaveFocus();
    expect(screen.getByText("Team name saved.")).toBeVisible();
  });

  it.each([members, "/shared-projects"])("handles a delayed Team deletion while visiting %s", async (destination) => {
    const receipt = Promise.withResolvers<Response>();
    const fetcher = install((url, init) => url === `/api/v1/teams/${teamId}` && init?.method === "DELETE" ? receipt.promise : undefined);
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: "Delete Team" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete Team" });
    fireEvent.change(within(confirmation).getByLabelText("Enter the Team name to confirm"), { target: { value: "Alpha" } });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete Team" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    go(destination);
    if (destination === members) await screen.findByRole("button", { name: "Leave Team" });
    else await screen.findByRole("heading", { name: "Projects shared with me" });
    await act(async () => receipt.resolve(json({ teamId, deleted: true })));
    await screen.findByText("Team deleted", { selector: ".notice" });
    expect(window.location.pathname).toBe(destination);
    expect(localStorage.getItem(`daynight.selectedTeam:${userId}`)).toBe(personal);
  });

  it("returns to Personal when a pending self exit completes on General", async () => {
    window.history.replaceState(null, "", members);
    const receipt = Promise.withResolvers<Response>();
    const fetcher = install((url, init) => {
      if (url === `/api/v1/teams/${teamId}`) return json(team("Alpha", "member"));
      if (url === `/api/v1/teams/${teamId}/members`) return json(roster("member"));
      if (url === `/api/v1/teams/${teamId}/members/${userId}` && init?.method === "DELETE") return receipt.promise;
      return undefined;
    });
    render(<AuthenticatedApp />); fireEvent.click(await screen.findByRole("button", { name: "Leave Team" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Leave Team" })).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    go(general); await screen.findByText("Only an admin of an ordinary Team can change its settings.");
    await act(async () => receipt.resolve(json({ teamId, userId, removed: true, actorRole: null })));
    await waitFor(() => expect(window.location.pathname).toBe(`/teams/${personal}`));
  });

  it("retains each unknown invitation revoke after another succeeds and the workspace is revisited", async () => {
    window.history.replaceState(null, "", members);
    const unknownId = "00000000-0000-4000-8000-000000000005", otherInvitationId = "00000000-0000-4000-8000-000000000006";
    const invitation = (id: string) => ({ id, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null });
    let invitations = [invitation(unknownId), invitation(otherInvitationId)];
    const fetcher = install((url, init) => {
      if (url === `/api/v1/teams/${teamId}/invitations`) return json({ items: invitations });
      if (url === `/api/v1/teams/${teamId}/invitations/${unknownId}` && init?.method === "DELETE") return Promise.reject(new TypeError("Connection lost"));
      if (url === `/api/v1/teams/${teamId}/invitations/${otherInvitationId}` && init?.method === "DELETE") {
        invitations = invitations.filter(item => item.id !== otherInvitationId);
        return json({ teamId, invitationId: otherInvitationId, changed: true });
      }
      return undefined;
    });
    render(<AuthenticatedApp />);
    const unknownRevoke = await screen.findByRole("button", { name: `Revoke invitation ${unknownId}` });
    await waitFor(() => expect(unknownRevoke).toBeEnabled());
    const memberList = document.querySelector(".team-members-list");
    fireEvent.click(unknownRevoke);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke invitation" }));
    const unknownDialog = screen.getByRole("dialog");
    expect(await within(unknownDialog).findByRole("alert")).toHaveTextContent("not confirmed");
    fireEvent.click(within(unknownDialog).getByRole("button", { name: "Read current invitations" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(unknownRevoke).toBeDisabled();
    const otherRevoke = screen.getByRole("button", { name: `Revoke invitation ${otherInvitationId}` });
    await waitFor(() => expect(otherRevoke).toBeEnabled());
    fireEvent.click(otherRevoke);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke invitation" }));
    await screen.findByText("Invitation revoked.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite member" })).toBeEnabled());
    expect(screen.queryByRole("dialog")).toBeNull();
    go("/shared-projects"); await screen.findByRole("heading", { name: "Projects shared with me" });
    expect(unknownRevoke).not.toBeVisible();
    go(members);
    const revisited = await screen.findByRole("button", { name: `Revoke invitation ${unknownId}` });
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite member" })).toBeEnabled());
    expect(revisited).toBeDisabled();
    expect(document.querySelector(".team-members-list")).toBe(memberList);
    fireEvent.click(revisited);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/${unknownId}`) && init?.method === "DELETE")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/${otherInvitationId}`) && init?.method === "DELETE")).toHaveLength(1);
  });

  it("retains an invitation's one-time link across both settings sections", async () => {
    window.history.replaceState(null, "", members);
    const invitationId = "00000000-0000-4000-8000-000000000005";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const fetcher = install((url, init) => url === `/api/v1/teams/${teamId}/invitations` && init?.method === "POST" ? json({ id: invitationId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201) : undefined);
    render(<AuthenticatedApp />);
    const invite = await screen.findByRole("button", { name: "Invite member" });
    await waitFor(() => expect(invite).toBeEnabled());
    fireEvent.click(invite);
    const create = within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const secret = await screen.findByDisplayValue(link);
    go(general); await screen.findByRole("button", { name: "Edit" }); expect(secret).not.toBeVisible();
    go(members); await waitFor(() => expect(secret).toBeVisible());
    expect(screen.getByDisplayValue(link)).toBe(secret);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
