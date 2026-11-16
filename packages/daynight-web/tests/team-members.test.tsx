import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamMembersPanel } from "../src/features/teams/TeamMembersPanel";
import { cancelAuthNetworkRequests } from "../src/api/client";
import { navigate } from "../src/app/router";
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

const setup = (options: { actor?: Role; other?: Role; personal?: boolean; invitations?: readonly unknown[]; teamRead?: () => Response | Promise<Response> | undefined; rosterRead?: () => Response | Promise<Response> | undefined; invitationRead?: () => Response | Promise<Response> | undefined; mutate?: (method: string, body: string, signal: AbortSignal | null | undefined) => Response | Promise<Response> } = {}) => {
  let actor = options.actor ?? "admin", other = options.other ?? "admin", unavailable = false, forbidden = false, networkFailure = false;
  const changed = vi.fn(), left = vi.fn(), mismatch = vi.fn(), onUnavailable = vi.fn(() => "forgotten" as const);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: mismatch });
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") return Promise.resolve(options.mutate?.(method, String(init?.body), init?.signal) ?? fail("forbidden"));
    if (networkFailure && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.reject(new TypeError("network failure"));
    if (forbidden && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.resolve(response({ error: { code: "forbidden", message: "forbidden", requestId: "request-1" } }, 403));
    if (unavailable && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.resolve(response({ error: { code: "not_found", message: "not_found", requestId: "request-1" } }, 404));
    if (url === `/api/v1/teams/${teamId}` && options.teamRead) { const result = options.teamRead(); if (result !== undefined) return Promise.resolve(result); }
    if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(response({ id: teamId, kind: options.personal ? "personal" : "ordinary", name: options.personal ? null : "Alpha", version: 1n, createdAt: time, updatedAt: time, membership: membership(userId, actor) }));
    if (url === `/api/v1/teams/${teamId}/invitations` && options.invitationRead) { const result = options.invitationRead(); if (result !== undefined) return Promise.resolve(result); }
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
const row = (name: string) => within(document.querySelector(".team-members-list") as HTMLElement).getByText(name, { selector: ".person-name" }).closest(".team-member-row") as HTMLElement;

describe("Team members", () => {
  it("retains the member confirmation and invitation list throughout background reads", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const invitation = { id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
    const teamRead = Promise.withResolvers<Response>(), rosterRead = Promise.withResolvers<Response>(), invitationRead = Promise.withResolvers<Response>(), readyGate = Promise.withResolvers<void>();
    let teamReads = 0, rosterReads = 0, invitationReads = 0, holdReady = false;
    const fixture = setup({ invitations: [invitation], teamRead: () => ++teamReads === 2 ? teamRead.promise : undefined, rosterRead: () => ++rosterReads === 2 ? rosterRead.promise : undefined, invitationRead: () => ++invitationReads === 2 ? invitationRead.promise : undefined });
    const originalReady = fixture.scope.ready.bind(fixture.scope);
    vi.spyOn(fixture.scope, "ready").mockImplementation(async (signal) => { await originalReady(signal); if (holdReady) await readyGate.promise; signal.throwIfAborted(); });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    const invite = await screen.findByRole("button", { name: `Revoke invitation ${inviteId}` });
    const member = row(otherId); fireEvent.click(within(member).getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove member" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }); cancel.focus();
    const check = () => {
      expect(within(document.querySelector(".team-members-list") as HTMLElement).getByText(otherId).closest(".team-member-row")).toBe(member); expect(member).toBeVisible();
      expect(screen.getByRole("button", { name: `Revoke invitation ${inviteId}` })).toBe(invite); expect(invite).toBeVisible();
      expect(screen.getByRole("dialog", { name: "Remove member" })).toBe(dialog); expect(dialog).toBeVisible(); expect(cancel).toHaveFocus();
      expect(document.querySelectorAll(".empty-inline")).toHaveLength(0); expect(writes(fixture.fetcher)).toHaveLength(0);
    };
    check(); fixture.rerender(panel(true)); check(); fixture.rerender(panel(false));
    await waitFor(() => { expect(teamReads).toBe(2); expect(rosterReads).toBe(2); expect(invitationReads).toBe(1); }); check();
    await act(async () => teamRead.resolve(response({ id: teamId, kind: "ordinary", name: "Alpha", version: 1n, createdAt: time, updatedAt: time, membership: membership(userId, "admin") }))); check();
    holdReady = true;
    await act(async () => rosterRead.resolve(response({ items: [{ ...membership(userId, "admin"), profile: profile("Alice") }, { ...membership(otherId, "admin", 9007199254740993n), profile: profile(null) }] }))); check();
    holdReady = false; await act(async () => readyGate.resolve()); check();
    await waitFor(() => expect(invitationReads).toBe(2));
    await act(async () => invitationRead.resolve(response({ items: [{ ...invitation }] }))); check();
    expect(within(dialog).getByRole("button", { name: "Remove member" })).toBeEnabled();
  });
  it("shows nullable profiles and lets an admin cancel a role change without writing", async () => {
    const fixture = setup();
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    const other = row(otherId);
    expect(within(other).getByRole("button", { name: "Remove" })).toBeEnabled();
    const role = within(other).getByRole("combobox");
    fireEvent.change(role, { target: { value: "member" } });
    expect(role).toHaveValue("admin");
    expect(writes(fixture.fetcher)).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Change Team role" })).toHaveTextContent("Administrator → Member");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(other).getByRole("combobox")).toBe(role); expect(role).toHaveValue("admin");
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
  it("settles a member receipt while admission waits and publishes it only after recovery", async () => {
    const write = Promise.withResolvers<Response>(), gate = Promise.withResolvers<void>(); let held = false;
    const fixture = setup({ mutate: () => write.promise });
    const originalReady = fixture.scope.ready.bind(fixture.scope);
    vi.spyOn(fixture.scope, "ready").mockImplementation(async (signal) => {
      await originalReady(signal);
      if (held) await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        void gate.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      signal.throwIfAborted();
    });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" }); await screen.findByText(/No active invitations/);
    fireEvent.change(within(row(otherId)).getByRole("combobox"), { target: { value: "member" } });
    const dialog = screen.getByRole("dialog", { name: "Change Team role" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    const readsBefore = fixture.fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET").length;
    held = true;
    await act(async () => write.resolve(response({ membership: membership(otherId, "member", 9007199254740994n), actorRole: "admin" })));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(readsBefore);
    fixture.setOther("member"); held = false; await act(async () => gate.resolve());
    await waitFor(() => expect(fixture.changed).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(row(otherId)).getByRole("combobox")).toHaveValue("member")); expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("retains an unpublished invitation receipt when another confirmation is opened", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const write = Promise.withResolvers<Response>(), gate = Promise.withResolvers<void>(); let held = false;
    const fixture = setup({ mutate: () => write.promise });
    const originalReady = fixture.scope.ready.bind(fixture.scope);
    vi.spyOn(fixture.scope, "ready").mockImplementation(async (signal) => { if (held) await gate.promise; await originalReady(signal); });
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    const dialog = screen.getByRole("dialog", { name: "Create Team invitation" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invitation link" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1)); held = true;
    await act(async () => write.resolve(response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201)));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); fireEvent.click(invite);
    const next = screen.getByRole("dialog", { name: "Create Team invitation" });
    expect(within(next).getByRole("button", { name: "Create invitation link" })).toBeDisabled();
    held = false; await act(async () => gate.resolve());
    expect(screen.getByRole("dialog", { name: "Create Team invitation" })).toBe(next);
    fireEvent.click(within(next).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByDisplayValue(link)).toBeVisible(); expect(writes(fixture.fetcher)).toHaveLength(1);
  });

  it("recovers a confirmed invitation link after publication admission fails without another write", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const write = Promise.withResolvers<Response>();
    const fixture = setup({ mutate: () => write.promise });
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    const originalReady = fixture.scope.ready.bind(fixture.scope); let fail = true;
    vi.spyOn(fixture.scope, "ready").mockImplementation(async (signal) => { if (fail) { fail = false; throw new Error("publication gate failed"); } await originalReady(signal); });
    await act(async () => write.resolve(response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201)));
    expect(await screen.findByText("The operation succeeded, but its result could not be displayed.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry showing result" }));
    expect(await screen.findByDisplayValue(link)).toBeVisible(); expect(writes(fixture.fetcher)).toHaveLength(1);
  });

  it("classifies a dispatched member write cancelled by the network lifetime as unknown", async () => {
    const fixture = setup({ mutate: (_method, _body, signal) => new Promise<Response>((_resolve, reject) => {
      if (!signal) throw new Error("missing network signal");
      if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row(otherId)).getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove member" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    act(() => cancelAuthNetworkRequests());
    expect(await within(dialog).findByText(/result is unknown/i)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Remove member" })).toBeNull();
    expect(fixture.changed).not.toHaveBeenCalled(); expect(writes(fixture.fetcher)).toHaveLength(1);
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
  it.each(["role", "remove", "self-demotion"] as const)("shows the confirmed %s receipt while refresh is pending and after failure", async (kind) => {
    const refresh = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({
      rosterRead: () => ++reads === 2 ? refresh.promise : undefined,
      mutate: () => {
        if (kind === "self-demotion") { fixture.setActor("member"); return response({ membership: membership(userId, "member", 2n), actorRole: "member" }); }
        if (kind === "role") return response({ membership: membership(otherId, "member", 9007199254740994n), actorRole: "admin" });
        return response({ teamId, userId: otherId, removed: true, actorRole: "admin" });
      }
    });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" }); await screen.findByText(/No active invitations/);
    const target = kind === "self-demotion" ? row("Alice") : row(otherId);
    if (kind === "remove") fireEvent.click(within(target).getByRole("button", { name: "Remove" }));
    else fireEvent.change(within(target).getByRole("combobox"), { target: { value: "member" } });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: kind === "remove" ? "Remove member" : "Confirm change" }));
    await waitFor(() => { expect(fixture.changed).toHaveBeenCalledOnce(); expect(reads).toBe(2); });
    const check = () => {
      const list = document.querySelector(".team-members-list") as HTMLElement;
      expect(list).toBeVisible();
      if (kind === "remove") expect(within(list).queryByText(otherId)).toBeNull();
      else expect(within(kind === "self-demotion" ? row("Alice") : row(otherId)).getByRole("combobox")).toHaveValue("member");
      if (kind === "self-demotion") expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();
      expect(writes(fixture.fetcher)).toHaveLength(1);
    };
    check(); await act(async () => refresh.reject(new TypeError("network failure")));
    await screen.findByText("Unable to read members."); check();
  });
  it("uses the confirmed member version after the refresh succeeds", async () => {
    const refresh = Promise.withResolvers<Response>(); let reads = 0, mutations = 0;
    const fixture = setup({ rosterRead: () => ++reads === 2 ? refresh.promise : undefined, mutate: () => ++mutations === 1 ? response({ membership: membership(otherId, "member", 9007199254740994n), actorRole: "admin" }) : fail("last_admin") });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.change(within(row(otherId)).getByRole("combobox"), { target: { value: "member" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(within(row(otherId)).getByRole("combobox")).toHaveValue("member");
    await act(async () => refresh.resolve(response({ items: [{ ...membership(userId, "admin"), profile: profile("Alice") }, { ...membership(otherId, "member", 9007199254740994n), profile: profile(null) }] })));
    const remove = within(row(otherId)).getByRole("button", { name: "Remove" }); await waitFor(() => expect(remove).toBeEnabled()); fireEvent.click(remove);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(2));
    expect(writes(fixture.fetcher)[1]?.[1]?.body).toBe(`{"version":9007199254740994,"expectedUserId":"${userId}"}`);
  });
  it("retains the original confirmation after navigation while accepting its role receipt", async () => {
    const write = Promise.withResolvers<Response>(), refresh = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({ mutate: () => write.promise, rosterRead: () => ++reads === 2 ? refresh.promise : undefined });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.change(within(row(otherId)).getByRole("combobox"), { target: { value: "member" } });
    const dialog = screen.getByRole("dialog", { name: "Change Team role" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    act(() => navigate("/shared-projects"));
    await act(async () => write.resolve(response({ membership: membership(otherId, "member", 9007199254740994n), actorRole: "admin" })));
    await waitFor(() => { expect(fixture.changed).toHaveBeenCalledWith(true); expect(reads).toBe(2); });
    expect(screen.getByRole("dialog", { name: "Change Team role" })).toBe(dialog);
    expect(within(row(otherId)).getByRole("combobox")).toHaveValue("member");
    await act(async () => refresh.resolve(response({ items: [{ ...membership(userId, "admin"), profile: profile("Alice") }, { ...membership(otherId, "member", 9007199254740994n), profile: profile(null) }] })));
    expect(within(dialog).getByRole("button", { name: "Confirm change" })).toBeDisabled();
  });
  it.each(["role", "remove", "self-exit"] as const)("keeps newer membership facts when a %s receipt arrives late", async (kind) => {
    const write = Promise.withResolvers<Response>(), refresh = Promise.withResolvers<Response>(); let reads = 0;
    const rejoinedAt = "2026-10-21T09:00:00Z";
    const fixture = setup({
      rosterRead: () => {
        reads++;
        if (reads === 2) return response({ items: [
          { ...membership(userId, "member", 2n), ...(kind === "self-exit" ? { createdAt: rejoinedAt, updatedAt: rejoinedAt } : {}), profile: profile("Alice") },
          { ...membership(otherId, "admin", kind === "remove" ? 1n : 9007199254740995n), ...(kind === "remove" ? { createdAt: rejoinedAt, updatedAt: rejoinedAt } : {}), profile: profile("New profile") }
        ] });
        return reads === 3 ? refresh.promise : undefined;
      },
      mutate: () => write.promise
    });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    await screen.findByText("Alice", { exact: false, selector: ".person-name" }); await screen.findByText(/No active invitations/);
    if (kind === "role") fireEvent.change(within(row(otherId)).getByRole("combobox"), { target: { value: "member" } });
    else fireEvent.click(within(row(kind === "self-exit" ? "Alice" : otherId)).getByRole("button", { name: kind === "self-exit" ? "Leave Team" : "Remove" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: kind === "role" ? "Confirm change" : kind === "self-exit" ? "Leave Team" : "Remove member" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    fixture.setActor("member"); fixture.rerender(panel(true)); fixture.rerender(panel(false));
    await screen.findByText("New profile", { selector: ".person-name" });
    expect(within(row("Alice")).getByRole("combobox")).toHaveValue("member");
    await act(async () => write.resolve(kind === "role" ? response({ membership: membership(otherId, "member", 9007199254740994n), actorRole: "admin" }) : response({ teamId, userId: kind === "self-exit" ? userId : otherId, removed: true, actorRole: kind === "self-exit" ? null : "admin" })));
    await waitFor(() => { expect(fixture.changed).toHaveBeenCalledOnce(); expect(reads).toBe(3); });
    expect(fixture.left).not.toHaveBeenCalled(); expect(within(row("Alice")).getByRole("combobox")).toHaveValue("member");
    expect(within(row("New profile")).getByRole("combobox")).toHaveValue("admin");
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull(); expect(writes(fixture.fetcher)).toHaveLength(1);
    await act(async () => refresh.reject(new TypeError("network failure"))); await screen.findByText("Unable to read members.");
    expect(within(row("New profile")).getByRole("combobox")).toHaveValue("admin"); expect(fixture.left).not.toHaveBeenCalled();
  });
  it("treats a successful self exit as complete without another Team read", async () => {
    const fixture = setup({ actor: "member", mutate: () => response({ teamId, userId, removed: true, actorRole: null }) });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row("Alice")).getByRole("button", { name: "Leave Team" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fixture.left).toHaveBeenCalledOnce());
    expect(fixture.left).toHaveBeenCalledWith(true, 1n);
    expect(fixture.fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
    expect(fixture.changed).not.toHaveBeenCalled();
  });
  it("does not withdraw a newer confirmed Team membership for an old self-exit receipt", async () => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup({ actor: "member", mutate: () => write.promise });
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    fireEvent.click(within(row("Alice")).getByRole("button", { name: "Leave Team" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(writes(fixture.fetcher)).toHaveLength(1));
    const newer = { id: teamId, kind: "ordinary" as const, name: "Alpha", version: 1n, createdAt: time, updatedAt: time, membership: membership(userId, "member", 2n) };
    fixture.rerender(<TeamMembersPanel teamId={teamId} confirmedTeam={newer} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />);
    await act(async () => write.resolve(response({ teamId, userId, removed: true, actorRole: null })));
    await waitFor(() => expect(fixture.changed).toHaveBeenCalledWith(true));
    expect(fixture.left).not.toHaveBeenCalled();
    expect(row("Alice")).toBeVisible();
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
  it("keeps an interrupted member reconciliation unknown after the recovery read", async () => {
    const interrupted = Promise.withResolvers<Response>(), recovery = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({ rosterRead: () => { reads++; return reads === 2 ? interrupted.promise : reads === 3 ? recovery.promise : undefined; }, mutate: () => Promise.reject(new TypeError("connection lost")) });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    await screen.findByText("Alice", { exact: false, selector: ".person-name" });
    await screen.findByText(/No active invitations/);
    fireEvent.click(within(row(otherId)).getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove member" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));
    await within(dialog).findByText(/result is unknown/);
    const check = within(dialog).getByRole("button", { name: "Check current state" }); fireEvent.click(check);
    await waitFor(() => expect(reads).toBe(2)); expect(check).toBeDisabled();
    fixture.rerender(panel(true)); expect(dialog).toBeVisible(); expect(check).toBeDisabled();
    fixture.rerender(panel(false)); await waitFor(() => expect(reads).toBe(3));
    const roster = () => response({ items: [{ ...membership(userId, "admin"), profile: profile("Alice") }, { ...membership(otherId, "admin", 9007199254740993n), profile: profile(null) }] });
    await act(async () => interrupted.resolve(roster()));
    expect(dialog).toBeVisible(); expect(within(dialog).getByText(/result is unknown/)).toBeVisible();
    expect(within(dialog).queryByRole("heading", { name: "Current membership" })).toBeNull();
    expect(document.querySelectorAll('.empty-inline[role="status"]')).toHaveLength(0); expect(writes(fixture.fetcher)).toHaveLength(1);
    await act(async () => recovery.resolve(roster())); await waitFor(() => expect(check).toBeEnabled());
    expect(within(dialog).queryByRole("heading", { name: "Current membership" })).toBeNull();
    expect(within(dialog).getByText(/result is unknown/)).toBeVisible(); expect(writes(fixture.fetcher)).toHaveLength(1);
    fireEvent.click(check); expect(await within(dialog).findByRole("heading", { name: "Current membership" })).toBeVisible();
    expect(within(dialog).getByText(/result is unknown/)).toBeVisible(); expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("retains invitations and the unknown revoke dialog while explicitly reading current state", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const invitation = { id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
    const read = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({ invitations: [invitation], invitationRead: () => ++reads === 2 ? read.promise : undefined, mutate: () => Promise.reject(new TypeError("connection lost")) });
    const revoke = await screen.findByRole("button", { name: `Revoke invitation ${inviteId}` });
    await waitFor(() => expect(revoke).toBeEnabled()); fireEvent.click(revoke);
    const dialog = screen.getByRole("dialog", { name: "Revoke invitation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
    await within(dialog).findByText(/invitation change was not confirmed/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Read current invitations" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole("dialog", { name: "Revoke invitation?" })).toBe(dialog); expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: `Revoke invitation ${inviteId}` })).toBe(revoke); expect(revoke).toBeVisible();
    expect(document.querySelectorAll(".empty-inline")).toHaveLength(0); expect(writes(fixture.fetcher)).toHaveLength(1);
    await act(async () => read.resolve(response({ items: [{ ...invitation }] })));
    expect(await screen.findByText(/original result is still unknown/)).toBeVisible();
    expect(screen.getByRole("button", { name: `Revoke invitation ${inviteId}` })).toBeDisabled(); expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("removes a confirmed revoked invitation while refresh is pending and after failure", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004", otherInvite = "00000000-0000-4000-8000-000000000005";
    const invitation = { id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
    const refresh = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({ invitations: [invitation, { ...invitation, id: otherInvite }], invitationRead: () => ++reads === 2 ? refresh.promise : undefined, mutate: () => response({ teamId, invitationId: inviteId, changed: true }) });
    const revoke = await screen.findByRole("button", { name: `Revoke invitation ${inviteId}` });
    await waitFor(() => expect(revoke).toBeEnabled()); fireEvent.click(revoke);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke invitation?" })).getByRole("button", { name: "Revoke invitation" }));
    await screen.findByText("Invitation revoked."); await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole("button", { name: `Revoke invitation ${inviteId}` })).toBeNull();
    expect(screen.getByRole("button", { name: `Revoke invitation ${otherInvite}` })).toBeVisible(); expect(writes(fixture.fetcher)).toHaveLength(1);
    await act(async () => refresh.reject(new TypeError("network failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("The operation could not be completed");
    expect(screen.queryByRole("button", { name: `Revoke invitation ${inviteId}` })).toBeNull(); expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("keeps an interrupted invitation reconciliation unknown after the recovery read", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const invitation = { id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
    const interrupted = Promise.withResolvers<Response>(), recovery = Promise.withResolvers<Response>(); let reads = 0;
    const fixture = setup({ invitations: [invitation], invitationRead: () => { reads++; return reads === 2 ? interrupted.promise : reads === 3 ? recovery.promise : undefined; }, mutate: () => Promise.reject(new TypeError("connection lost")) });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    const revoke = await screen.findByRole("button", { name: `Revoke invitation ${inviteId}` });
    await waitFor(() => expect(revoke).toBeEnabled()); fireEvent.click(revoke);
    const dialog = screen.getByRole("dialog", { name: "Revoke invitation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
    await within(dialog).findByText(/invitation change was not confirmed/);
    const check = within(dialog).getByRole("button", { name: "Read current invitations" }); fireEvent.click(check);
    await waitFor(() => expect(reads).toBe(2)); expect(check).toBeDisabled();
    fixture.rerender(panel(true)); expect(dialog).toBeVisible(); expect(check).toBeDisabled();
    fixture.rerender(panel(false)); await waitFor(() => expect(reads).toBe(3));
    await act(async () => {}); expect(reads).toBe(3);
    await act(async () => interrupted.resolve(response({ items: [{ ...invitation }] })));
    expect(dialog).toBeVisible(); expect(within(dialog).getByText(/invitation change was not confirmed/)).toBeVisible();
    expect(screen.queryByText(/original result is still unknown/)).toBeNull();
    expect(document.querySelectorAll(".empty-inline")).toHaveLength(0); expect(writes(fixture.fetcher)).toHaveLength(1);
    await act(async () => recovery.resolve(response({ items: [{ ...invitation }] })));
    await waitFor(() => expect(check).toBeEnabled());
    expect(dialog).toBeVisible(); expect(within(dialog).getByText(/invitation change was not confirmed/)).toBeVisible();
    expect(screen.queryByText(/original result is still unknown/)).toBeNull(); expect(revoke).toBeDisabled(); expect(writes(fixture.fetcher)).toHaveLength(1);
    fireEvent.click(check); expect(await screen.findByText(/original result is still unknown/)).toBeVisible();
    expect(revoke).toBeDisabled(); expect(writes(fixture.fetcher)).toHaveLength(1);
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
  it.each(["member", "unavailable", "network"] as const)("shows a confirmed invitation secret after navigation and %s", async (access) => {
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
  it("retains a confirmed invitation across navigation while the returning roster is pending", async () => {
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
    await waitFor(() => expect(reads).toBe(2)); expect(await screen.findByDisplayValue(link)).toBeVisible();
    await act(async () => roster.resolve(response({ items: [{ ...membership(userId, "member", 2n), profile: profile("Alice") }, { ...membership(otherId, "admin", 9007199254740993n), profile: profile(null) }] })));
    expect(screen.getByDisplayValue(link)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I have saved it, close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave Team" })).toBeEnabled());
  });
  it("keeps a confirmed invitation receipt without blocking leave after demotion", async () => {
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
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I have saved it, close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave Team" })).toBeEnabled());
    expect(writes(fixture.fetcher)).toHaveLength(1);
  });
  it("retains an invitation secret during checking and after confirmed demotion", async () => {
    const inviteId = "00000000-0000-4000-8000-000000000004";
    const link = `${window.location.origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const fixture = setup({ mutate: () => response({ id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2099-10-27T09:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null, link }, 201) });
    const panel = (blocked: boolean) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={fixture.scope} onIdentityMismatch={fixture.mismatch} onChanged={fixture.changed} onLeft={fixture.left} />;
    const invite = await screen.findByRole("button", { name: "Invite member" }); await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create invitation link" }));
    const secret = await screen.findByDisplayValue(link); expect(secret).toBeVisible();
    fixture.rerender(panel(true)); expect(secret).toBeVisible();
    fixture.setActor("member"); fixture.rerender(panel(false));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull());
    expect(secret).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I have saved it, close" }));
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
    if (kind === "guarded") {
      await act(async () => write.reject(new TypeError("lost")));
      await waitFor(() => expect(screen.getAllByText(/result is unknown/).some((node) => !node.closest('[hidden]'))).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText(/result is unknown/)).toBeVisible();
    }
    fixture.setForbidden(false); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    if (kind === "guarded") {
      await screen.findByText(otherId, { selector: ".person-name" });
      const remove = within(row(otherId)).getByRole("button", { name: "Remove" });
      await waitFor(() => expect(remove).toBeDisabled());
      fireEvent.click(remove); expect(screen.queryByRole("dialog", { name: "Remove member" })).toBeNull();
    } else {
      await waitFor(() => expect(dialog.parentElement).not.toHaveAttribute("hidden"));
      expect(screen.getByRole("dialog", { name: "Remove member" })).toBe(dialog);
    }
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
