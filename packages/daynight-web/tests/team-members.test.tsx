import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const setup = (options: { actor?: Role; other?: Role; personal?: boolean; mutate?: (method: string, body: string) => Response | Promise<Response> } = {}) => {
  let actor = options.actor ?? "admin", other = options.other ?? "admin";
  const changed = vi.fn(), left = vi.fn(), mismatch = vi.fn();
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: mismatch });
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") return Promise.resolve(options.mutate?.(method, String(init?.body)) ?? fail("forbidden"));
    if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(response({ id: teamId, kind: options.personal ? "personal" : "ordinary", name: options.personal ? null : "Alpha", version: 1n, createdAt: time, updatedAt: time, membership: membership(userId, actor) }));
    if (url === `/api/v1/teams/${teamId}/members`) return Promise.resolve(response({ items: [{ ...membership(userId, actor), profile: profile("Alice") }, { ...membership(otherId, other, 9007199254740993n), profile: profile(null) }] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<TeamMembersPanel teamId={teamId} admission={scope} onIdentityMismatch={mismatch} onChanged={changed} onLeft={left} />);
  return { ...view, fetcher, changed, left, mismatch, scope, setActor: (role: Role) => { actor = role; }, setOther: (role: Role) => { other = role; } };
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
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(4));
    expect(within(dialog).queryByRole("button", { name: "Remove member" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(within(row(otherId)).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(writes(fixture.fetcher)).toHaveLength(1);
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
