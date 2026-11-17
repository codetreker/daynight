import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamMembersPanel } from "../src/features/teams/TeamMembersPanel";
import { createTaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { stringifyWireJson } from "./helpers/wireJson";

const teamId = "00000000-0000-4000-8000-000000000003";
const actorId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000004";
const otherId = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-20T09:00:00Z";
const membership = (userId: string, role: "member" | "admin", version = 1n) => ({ teamId, userId, role, version, createdAt: time, updatedAt: time });
const member = (userId: string, role: "member" | "admin") => ({ ...membership(userId, role), profile: { name: userId === actorId ? "Alice" : userId === targetId ? "Target" : "Bob", email: null, avatarUrl: null } });
const response = (value: unknown) => new Response(stringifyWireJson(value), { status: 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": actorId } });
vi.mock("../src/features/teams/member-search/TeamMemberSearch", () => ({ TeamMemberSearch: (props: { onAdd: (id: string) => void; addition: { locked: boolean } }) => <button type="button" disabled={props.addition.locked} onClick={() => props.onAdd(targetId)}>Add target</button> }));
const render = createLocaleRender("en");

const setup = (write: (method: string) => Promise<Response>, rosterRead?: (count: number) => Promise<Response> | undefined) => {
  let actor: "admin" | "member" = "admin";
  let unavailable = false;
  let rosterReads = 0;
  const mismatch = vi.fn(), changed = vi.fn(), left = vi.fn(), guard = vi.fn(), onUnavailable = vi.fn(() => "forgotten" as const);
  const scope = createTaskCacheScope({ userId: actorId, onIdentityMismatch: mismatch });
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") return write(method);
    if (unavailable && (url === `/api/v1/teams/${teamId}` || url === `/api/v1/teams/${teamId}/members`)) return Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "not found", requestId: "request-1" } }), { status: 404, headers: { "Content-Type": "application/json", "Daynight-User-ID": actorId } }));
    if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(response({ id: teamId, kind: "ordinary", name: "Alpha", version: 1n, createdAt: time, updatedAt: time, membership: membership(actorId, actor) }));
    if (url === `/api/v1/teams/${teamId}/members`) return rosterRead?.(++rosterReads) ?? Promise.resolve(response({ items: [member(actorId, actor), member(otherId, "admin")] }));
    if (url === `/api/v1/teams/${teamId}/invitations`) return Promise.resolve(response({ items: [] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const panel = (blocked = false) => <TeamMembersPanel teamId={teamId} admissionBlocked={blocked} admission={scope} onIdentityMismatch={mismatch} onChanged={changed} onLeft={left} onGuardChange={guard} onUnavailable={onUnavailable} />;
  const view = render(panel());
  return { ...view, fetcher, changed, left, guard, onUnavailable, panel, setUnavailable: () => { unavailable = true; }, setActor: (role: "admin" | "member") => { actor = role; } };
};

const waitAdd = async () => { const add = await screen.findByRole("button", { name: "Add target" }); await waitFor(() => expect(add).toBeEnabled()); fireEvent.click(add); };
const receipt = () => response({ membership: member(targetId, "member"), added: true, actorRole: "admin" });

describe("Team member addition owner", () => {
  it("keeps an unknown result after a read showing the target absent", async () => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup(() => write.promise);
    await waitAdd();
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    await act(async () => write.reject(new TypeError("lost response")));
    await screen.findByText(/The result is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Check current state" }));
    await screen.findByText(/Not currently a Team member/);
    expect(screen.getByRole("button", { name: "Add target" })).toBeDisabled();
    expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("serializes a simultaneous invitation submit against the first add", async () => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup(() => write.promise);
    const invite = await screen.findByRole("button", { name: "Invite member" });
    await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
    const submit = within(screen.getByRole("dialog", { name: "Create Team invitation" })).getByRole("button", { name: "Create invitation link" });
    const add = screen.getByRole("button", { name: "Add target" });
    await act(async () => { add.click(); submit.click(); });
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    expect(fixture.fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[0]).toBe(`/api/v1/teams/${teamId}/members/${targetId}`);
    await act(async () => write.resolve(receipt()));
    expect(await screen.findByText(/Member added/)).toHaveAttribute("role", "status");
  });
  it("installs a receipt after an earlier roster read, even when the subsequent check fails", async () => {
    const write = Promise.withResolvers<Response>(), roster = Promise.withResolvers<Response>();
    const fixture = setup(() => write.promise, count => count === 2 ? roster.promise : count > 2 ? Promise.reject(new TypeError("offline")) : undefined);
    await waitAdd();
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    fixture.rerender(fixture.panel(true)); fixture.rerender(fixture.panel(false));
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url]) => url === `/api/v1/teams/${teamId}/members`)).toHaveLength(2));
    await act(async () => roster.resolve(response({ items: [member(actorId, "admin"), member(otherId, "admin")] })));
    await act(async () => write.resolve(receipt()));
    expect(await screen.findByText("Target", { selector: ".person-name" })).toBeVisible();
    await screen.findByText("Unable to read members.");
    expect(screen.getByText("Target", { selector: ".person-name" })).toBeVisible();
  });
  it("permits self exit after a downgrade without losing the unknown result", async () => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup(method => method === "POST" ? write.promise : Promise.resolve(response({ teamId, userId: actorId, removed: true, actorRole: null })));
    await waitAdd(); await act(async () => write.reject(new TypeError("lost response")));
    await screen.findByText(/The result is unknown/);
    fixture.rerender(fixture.panel(true)); fixture.setActor("member"); fixture.rerender(fixture.panel(false));
    const leave = await screen.findByRole("button", { name: "Leave Team" });
    await waitFor(() => expect(leave).toBeEnabled()); fireEvent.click(leave);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Leave Team" })).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fixture.left).toHaveBeenCalledOnce());
    expect(screen.getByText(/The result is unknown/)).toBeVisible();
  });
  it("does not restore the roster when an old receipt arrives after self exit", async () => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup(method => method === "POST" ? write.promise : Promise.resolve(response({ teamId, userId: actorId, removed: true, actorRole: null })));
    await waitAdd();
    fixture.rerender(fixture.panel(true)); fixture.setActor("member"); fixture.rerender(fixture.panel(false));
    const leave = await screen.findByRole("button", { name: "Leave Team" });
    await waitFor(() => expect(leave).toBeEnabled()); fireEvent.click(leave);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Leave Team" })).getByRole("button", { name: "Leave Team" }));
    await waitFor(() => expect(fixture.left).toHaveBeenCalledOnce());
    await act(async () => write.resolve(receipt()));
    expect(screen.queryByText("Target")).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave Team" })).toBeNull();
  });
  it("retains an in-flight add across a not-found access check while clearing the roster", async () => {
    const write = Promise.withResolvers<Response>();
    const fixture = setup(() => write.promise);
    await waitAdd();
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    fixture.rerender(fixture.panel(true)); fixture.setUnavailable(); fixture.rerender(fixture.panel(false));
    await screen.findByText("This Team is unavailable or you do not have access.");
    expect(fixture.onUnavailable).not.toHaveBeenCalled();
    expect(screen.queryByText("Alice", { selector: ".person-name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add target" })).toBeNull();
    await act(async () => write.reject(new TypeError("lost response")));
    expect(await screen.findByText(/The result is unknown/)).toBeVisible();
    fixture.rerender(fixture.panel(true)); fixture.rerender(fixture.panel(false));
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url]) => url === `/api/v1/teams/${teamId}`)).toHaveLength(3));
    expect(fixture.onUnavailable).not.toHaveBeenCalled();
  });
});
