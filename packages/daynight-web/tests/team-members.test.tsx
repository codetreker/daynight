import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamMembersPanel } from "../src/features/teams/TeamMembersPanel";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { stringifyWireJson } from "./helpers/wireJson";

const render = createLocaleRender("en");
const teamId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-20T09:00:00Z";
type Role = "admin" | "member";
const membership = (id: string, role: Role, version = 1n) => ({ teamId, userId: id, role, version, createdAt: time, updatedAt: time });
const profile = (name: string | null) => ({ name, email: null, avatarUrl: null });
const response = (value: unknown, status = 200, principal = userId) => new Response(stringifyWireJson(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const fail = (code: string) => response({ error: { code, message: "failure", requestId: "request-1" } }, 409);

const setup = (options: { actor?: Role; other?: Role; personal?: boolean; invitations?: readonly unknown[]; rosterRead?: () => Response | Promise<Response> | undefined; mutate?: (method: string, body: string) => Response | Promise<Response> } = {}) => {
  let actor = options.actor ?? "admin", other = options.other ?? "admin", unavailable = false, forbidden = false, networkFailure = false;
  const changed = vi.fn(), left = vi.fn(), mismatch = vi.fn(), onUnavailable = vi.fn(() => "forgotten" as const);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: mismatch });
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") return Promise.resolve(options.mutate?.(method, String(init?.body)) ?? fail("forbidden"));
    if (networkFailure && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.reject(new TypeError("network failure"));
    if (forbidden && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.resolve(response({ error: { code: "forbidden", message: "forbidden", requestId: "request-1" } }, 403));
    if (unavailable && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.resolve(response({ error: { code: "not_found", message: "not_found", requestId: "request-1" } }, 404));
    if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(response({ id: teamId, kind: options.personal ? "personal" : "ordinary", name: options.personal ? null : "Alpha", version: 1n, createdAt: time, updatedAt: time, membership: membership(userId, actor) }));
    if (url === `/api/v1/teams/${teamId}/invitations`) return Promise.resolve(response({ items: options.invitations ?? [] }));
    if (url === `/api/v1/teams/${teamId}/members` && options.rosterRead) { const result = options.rosterRead(); if (result !== undefined) return Promise.resolve(result); }
    if (url === `/api/v1/teams/${teamId}/members`) return Promise.resolve(response({ items: [{ ...membership(userId, actor), profile: profile("Alice") }, { ...membership(otherId, other, 9007199254740993n), profile: profile(null) }] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<TeamMembersPanel teamId={teamId} admission={scope} onIdentityMismatch={mismatch} onChanged={changed} onLeft={left} onUnavailable={onUnavailable} />);
  return { ...view, fetcher, changed, left, mismatch, onUnavailable, scope, setUnavailable: (value: boolean) => { unavailable = value; }, setForbidden: (value: boolean) => { forbidden = value; }, setNetworkFailure: (value: boolean) => { networkFailure = value; }, setActor: (role: Role) => { actor = role; }, setOther: (role: Role) => { other = role; } };
};
const writes = (fetcher: ReturnType<typeof setup>["fetcher"]) => fetcher.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
const row = (name: string) => screen.getByText(name, { selector: ".person-name" }).closest(".team-member-row") as HTMLElement;

describe("Team members", () => {
  it("shows nullable profiles and lets an admin cancel a role change without writing", async () => {
    const fixture = setup();
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    const other = row(otherId);
    expect(within(other).getByRole("button", { name: "Remove" })).toBeEnabled();
    fireEvent.change(within(other).getByRole("combobox"), { target: { value: "member" } });
    expect(screen.getByRole("dialog", { name: "Change Team role" })).toHaveTextContent("Administrator → Member");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes(fixture.fetcher)).toHaveLength(0);
  });
  it("lets members leave but prevents changes to other people", async () => {
    setup({ actor: "member" });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    expect(within(row(otherId)).getByRole("combobox")).toBeDisabled();
    expect(within(row(otherId)).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(within(row("Alice")).getByRole("button", { name: "Leave Team" })).toBeEnabled();
  });
  it("keeps Personal membership immutable", async () => {
    setup({ personal: true });
    await screen.findByText("Personal Team membership and role are fixed.");
    for (const control of screen.getAllByRole("combobox")) expect(control).toBeDisabled();
    expect(screen.getByRole("button", { name: "Leave Team" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });
  it("submits self demotion with the observed version and refreshes context", async () => {
    const fixture = setup({ mutate: () => { fixture.setActor("member"); return response({ membership: membership(userId, "member", 2n), actorRole: "member" }); } });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.change(within(row("Alice")).getByRole("combobox"), { target: { value: "member" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(fixture.changed).toHaveBeenCalledOnce());
    expect(writes(fixture.fetcher)).toHaveLength(1);
    expect(writes(fixture.fetcher)[0]?.[1]?.body).toBe(`{"version":1,"role":"member","expectedUserId":"${userId}"}`);
    await waitFor(() => expect(within(row(otherId)).getByRole("button", { name: "Remove" })).toBeDisabled());
    expect(fixture.left).not.toHaveBeenCalled();
  });
  it("treats a successful self exit as complete without another Team read", async () => {
    const fixture = setup({ actor: "member", mutate: () => response({ teamId, userId, removed: true, actorRole: null }) });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row("Alice")).getByRole("button", { name: "Leave Team" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fixture.left).toHaveBeenCalledOnce());
    expect(fixture.fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
    expect(fixture.changed).not.toHaveBeenCalled();
  });
  it.each(["version_conflict", "last_admin"])("reports %s and requires review before another write", async (code) => {
    const fixture = setup({ mutate: () => fail(code) });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row(otherId)).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove member" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(code === "last_admin" ? "At least one admin must remain." : /Membership or permission changed/)).toBeInTheDocument();
    await waitFor(() => expect(fixture.changed).toHaveBeenCalledOnce());
    expect(within(dialog).getByRole("button", { name: "Remove member" })).toBeDisabled();
    expect(writes(fixture.fetcher)).toHaveLength(1);
    expect(writes(fixture.fetcher)[0]?.[1]?.body).toBe(`{"version":9007199254740993,"expectedUserId":"${userId}"}`);
  });
  it("never replays an unknown write after checking current state", async () => {
    const fixture = setup({ mutate: () => Promise.reject(new TypeError("connection lost")) });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row(otherId)).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove member" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText(/result is unknown/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check current state" }));
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url, init]) => !init?.method && !url.endsWith("/invitations"))).toHaveLength(4));
    expect(within(dialog).queryByRole("button", { name: "Remove member" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(within(row(otherId)).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it.each(["create", "revoke"] as const)("keeps unknown %s visible after demotion, permits leave and never replays", async (kind) => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const invitation = { id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
    const pending = Promise.withResolvers<Response>();
    const fixture = setup({ invitations: [invitation], mutate: (method) => method === "POST" || method === "DELETE" && kind === "revoke" && writes(fixture.fetcher).length === 1 ? pending.promise : response({ teamId, userId, removed: true, actorRole: null }) });
    const panel = (active: boolean, onRoute: boolean) => <TeamMembersPanel teamId={teamId} active={active} onRoute={onRoute} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    if (kind === "create") {
      const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    } else {
      const revoke = await screen.findByRole("button", { name: `Revoke invitation ${inviteId}` }); await waitFor(() => expect(revoke).toBeEnabled()); fireEvent.click(revoke);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke invitation" }));
    }
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    fixture.rerender(panel(false, false)); fixture.setActor("member");
    await act(async () => pending.reject(new TypeError("connection lost")));
    fixture.rerender(panel(true, true));
    expect(await screen.findByText(/invitation change is still unconfirmed/)).toBeInTheDocument();
    const leave = screen.getByRole("button", { name: "Leave Team" }); await waitFor(() => expect(leave).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Read current invitations" })).toBeNull();
    fixture.rerender(panel(false, false)); fixture.setActor("admin"); fixture.rerender(panel(true, true));
    const check = await screen.findByRole("button", { name: "Read current invitations" }); await waitFor(() => expect(check).toBeEnabled());
    expect(writes(fixture.fetcher)).toHaveLength(1); fireEvent.click(check);
    await screen.findByText(/original result is still unknown/);
    if (kind === "revoke") expect(screen.getByRole("button", { name: `Revoke invitation ${inviteId}` })).toBeDisabled();
    fixture.rerender(panel(false, false)); fixture.setActor("member"); fixture.rerender(panel(true, true));
    expect(await screen.findByText(/invitation change is still unconfirmed/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave Team" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Leave Team" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fixture.left).toHaveBeenCalledOnce());
    expect(writes(fixture.fetcher)).toHaveLength(2);
    expect(writes(fixture.fetcher)[0]?.[0]).toContain('/invitations');
    expect(writes(fixture.fetcher)[1]?.[0]).toContain('/members/');
  });
  it.each(["member", "unavailable", "network"] as const)("holds a new invitation secret after navigation and %s until permissions recover", async (access) => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const pending = Promise.withResolvers<Response>();
    const fixture = setup({ mutate: () => pending.promise });
    const panel = (active: boolean, onRoute: boolean) => <TeamMembersPanel teamId={teamId} active={active} onRoute={onRoute} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} onUnavailable={fixture.onUnavailable} />;
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1)); fixture.rerender(panel(false, false));
    if (access === "member") fixture.setActor("member"); else if (access === "unavailable") fixture.setUnavailable(true); else fixture.setNetworkFailure(true);
    await act(async () => pending.resolve(response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201)));
    fixture.rerender(panel(true, true));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull());
    expect(screen.queryByDisplayValue(link)).toBeNull();
    if (access === "member" || access === "unavailable") await screen.findByText(/invitation was created, but you no longer have permission/);
    fixture.setActor("admin"); fixture.setUnavailable(false); fixture.setNetworkFailure(false);
    fixture.rerender(panel(false, false)); fixture.rerender(panel(true, true));
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I have saved it, close" }));
    expect(screen.queryByDisplayValue(link)).toBeNull(); expect(writes(fixture.fetcher)).toHaveLength(1);
    if (access === "unavailable") expect(fixture.onUnavailable).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "network"] as const)("retains an unknown invitation when Team reading fails with %s", async (failure) => {
    const pending = Promise.withResolvers<Response>();
    const fixture = setup({ mutate: () => pending.promise });
    const panel = (active: boolean, onRoute: boolean) => <TeamMembersPanel teamId={teamId} active={active} onRoute={onRoute} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} onUnavailable={fixture.onUnavailable} />;
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1)); fixture.rerender(panel(false, false)); if (failure === "unavailable") fixture.setUnavailable(true); else fixture.setNetworkFailure(true);
    await act(async () => pending.reject(new TypeError("connection lost"))); fixture.rerender(panel(true, true));
    if (failure === "unavailable") {
      expect(await screen.findByText(/invitation change is still unconfirmed; this Team is unavailable/)).toBeInTheDocument();
      expect(screen.getByText("This Team is unavailable or you do not have access.")).toBeInTheDocument();
    } else {
      expect(await screen.findByText("Unable to read members.")).toBeInTheDocument();
      expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("invitation change was not confirmed"))).toBe(true);
      expect(screen.queryByText(/no longer have permission/)).toBeNull();
    }
    expect(fixture.onUnavailable).not.toHaveBeenCalled(); expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("withholds a late invitation across navigation until the returning roster confirms access", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const write = Promise.withResolvers<Response>(), roster = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({ mutate: () => write.promise, rosterRead: () => ++reads === 2 ? roster.promise : undefined });
    const panel = (active: boolean) => <TeamMembersPanel teamId={teamId} active={active} onRoute={active} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1)); fixture.rerender(panel(false));
    await act(async () => write.resolve(response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201)));
    fixture.setActor("member"); fixture.rerender(panel(true));
    await waitFor(() => expect(reads).toBe(2)); expect(screen.queryByDisplayValue(link)).toBeNull();
    await act(async () => roster.resolve(response({ items: [{ ...membership(userId, "member", 2n), profile: profile("Alice") }, { ...membership(otherId, "admin", 9007199254740993n), profile: profile(null) }] })));
    expect(await screen.findByText(/invitation was created, but you no longer have permission/)).toBeVisible();
    expect(screen.queryByDisplayValue(link)).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave Team" })).toBeEnabled());
  });
  it("keeps a withheld invitation receipt without blocking leave after confirmed demotion", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const write = Promise.withResolvers<Response>();
    const fixture = setup({ mutate: () => write.promise });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    fixture.rerender(panel(true)); fixture.setActor("member"); fixture.rerender(panel(false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull());
    await act(async () => write.resolve(response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201)));
    expect(await screen.findByText(/invitation was created, but you no longer have permission/)).toBeVisible();
    expect(screen.queryByDisplayValue(link)).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave Team" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/invitation was created, but you no longer have permission/)).toBeNull();
    expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("retains an invitation secret during checking and hides it after confirmed demotion", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const fixture = setup({ mutate: () => response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201) });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    const secret = await screen.findByDisplayValue(link); expect(secret).toBeVisible();
    fixture.rerender(panel(true)); expect(secret).toBeVisible();
    fixture.setActor("member"); fixture.rerender(panel(false));
    await waitFor(() => expect(secret).not.toBeVisible());
    expect(screen.queryByRole("button", { name: "I have saved it, close" })).toBeNull();
    expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it.each(["unguarded", "guarded"] as const)("isolates member actions on 403 and recovers the %s state", async (kind) => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup({ mutate: () => write.promise });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} onUnavailable={fixture.onUnavailable} />;
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row(otherId)).getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove member" });
    if (kind === "guarded") { fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" })); await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1)); }
    fixture.setForbidden(true); fixture.rerender(panel(true)); fixture.rerender(panel(false));
    await waitFor(() => expect(dialog.parentElement).toHaveAttribute("hidden"));
    expect(screen.queryByText("Alice", { selector: ".person-name" })).toBeNull();
    if (kind === "guarded") { await act(async () => write.reject(new TypeError("lost"))); await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest('[hidden]'))).toBe(true)); }
    fixture.setForbidden(false); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.parentElement).not.toHaveAttribute("hidden"));
    expect(screen.getByRole("dialog", { name: "Remove member" })).toBe(dialog);
    expect(writes(fixture.fetcher)).toHaveLength(kind === "guarded" ? 1 : 0);
  });
  it("rejects a response from another principal without installing its success", async () => {
    const fixture = setup({ mutate: () => response({ teamId, userId: otherId, removed: true, actorRole: "admin" }, 200, otherId) });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row(otherId)).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(fixture.mismatch).toHaveBeenCalledOnce());
    expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.left).not.toHaveBeenCalled();
    expect(writes(fixture.fetcher)).toHaveLength(1);
  });
});
