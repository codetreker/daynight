import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeam, deleteTeam, getTeam, listTeams, renameTeam } from "../src/api/teams";
import { invalidateAuthRequests } from "../src/api/client";

const user = "00000000-0000-4000-8000-000000000001";
const team = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-20T09:00:00Z";
const source = (changes = "") => `{"id":"${team}","kind":"ordinary","name":"  Example 团队  ","version":9223372036854775807,"createdAt":"${time}","updatedAt":"${time}","membership":{"teamId":"${team}","userId":"${user}","role":"member","version":9223372036854775806,"createdAt":"${time}","updatedAt":"${time}"}${changes}}`;
const response = (body: string, principal = user) => new Response(body, { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("Team reads", () => {
  it("preserves names and exact metadata and membership versions on detail and pages", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(source())).mockResolvedValueOnce(response(`{"items":[${source()}],"nextCursor":"next/+"}`)); vi.stubGlobal("fetch", fetch);
    const detail = await getTeam(team, user, new AbortController().signal, vi.fn());
    expect(detail.name).toBe("  Example 团队  "); expect(detail.version).toBe(9223372036854775807n); expect(detail.membership.version).toBe(9223372036854775806n);
    const page = await listTeams(null, user, new AbortController().signal, vi.fn());
    expect(page.items).toEqual([detail]); expect(page.nextCursor).toBe("next/+");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v1/teams?limit=50");
  });
  it("rejects malformed, inconsistent and wrong-principal responses", async () => {
    const mismatch = vi.fn();
    for (const body of [source().replace(team, user), source().replace(`"userId":"${user}"`, `"userId":"${team}"`), source().replace('"role":"member"', '"role":"owner"'), source(',"unexpected":true'), source().replace('9223372036854775807', '0')]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
      await expect(getTeam(team, user, new AbortController().signal, mismatch)).rejects.toMatchObject({ kind: "protocol" });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(source(), team)));
    await expect(getTeam(team, user, new AbortController().signal, mismatch)).rejects.toMatchObject({ code: "principal_mismatch" }); expect(mismatch).toHaveBeenCalledOnce();
  });
  it("rejects a successful status other than 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(source(), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": user } })));
    await expect(getTeam(team, user, new AbortController().signal, vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 201 });
  });
});

describe("Team lifecycle mutations", () => {
  const adminSource = (name = "  Example 团队  ", version = "9223372036854775806") => source().replace('"role":"member"', '"role":"admin"').replace('  Example 团队  ', name).replace('9223372036854775807', version);
  const mutationResponse = (body: string, status = 200, principal = user, location?: string) => new Response(body, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal, ...(location === undefined ? {} : { Location: location }) } });
  const signal = () => new AbortController().signal;
  const admin = async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(adminSource())));
    return getTeam(team, user, signal(), vi.fn());
  };

  it("creates a Team using the raw name and validates the committed receipt and Location", async () => {
    const dispatch = vi.fn(), mismatch = vi.fn();
    const fetch = vi.fn().mockResolvedValue(mutationResponse(adminSource(), 201, user, `/api/v1/teams/${team}`)); vi.stubGlobal("fetch", fetch);
    const result = await createTeam(user, "  Example 团队  ", signal(), mismatch, dispatch);
    expect(result.membership.role).toBe("admin"); expect(result.version).toBe(9223372036854775806n);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/teams");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ name: "  Example 团队  ", expectedUserId: user });
    expect(dispatch).toHaveBeenCalledOnce(); expect(mismatch).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mutationResponse(adminSource(), 201, user, "/api/v1/teams/other")));
    await expect(createTeam(user, "  Example 团队  ", signal(), mismatch, vi.fn())).rejects.toMatchObject({ kind: "protocol" });
  });

  it("sends exact versions and original names for rename and delete", async () => {
    const current = await admin();
    const fetch = vi.fn().mockResolvedValueOnce(mutationResponse(adminSource("Next", "9223372036854775807"))).mockResolvedValueOnce(mutationResponse(`{"teamId":"${team}","deleted":true}`)); vi.stubGlobal("fetch", fetch);
    expect((await renameTeam(user, current, "Next", signal(), vi.fn(), vi.fn())).version).toBe(9223372036854775807n);
    expect(fetch.mock.calls[0]?.[1].body).toBe(`{"name":"Next","version":9223372036854775806,"expectedUserId":"${user}"}`);
    expect(await deleteTeam(user, current, signal(), vi.fn(), vi.fn())).toEqual({ teamId: team, deleted: true });
    expect(fetch.mock.calls[1]?.[1].body).toBe(`{"name":"  Example 团队  ","version":9223372036854775806,"expectedUserId":"${user}"}`);
  });

  it("preserves multiline names and accepts an unchanged rename version", async () => {
    const current = await admin();
    const name = "A\r\nB\nC";
    const body = adminSource().replace('"  Example 团队  "', JSON.stringify(name));
    const fetch = vi.fn().mockResolvedValueOnce(mutationResponse(body, 201, user, `/api/v1/teams/${team}`)).mockResolvedValueOnce(mutationResponse(adminSource())); vi.stubGlobal("fetch", fetch);
    expect((await createTeam(user, name, signal(), vi.fn(), vi.fn())).name).toBe(name);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body).name).toBe(name);
    expect((await renameTeam(user, current, current.name!, signal(), vi.fn(), vi.fn())).version).toBe(current.version);
  });

  it("does not dispatch when cancellation precedes the request", async () => {
    const controller = new AbortController(), dispatch = vi.fn(), fetch = vi.fn();
    controller.abort(); vi.stubGlobal("fetch", fetch);
    await expect(createTeam(user, "Name", controller.signal, vi.fn(), dispatch)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects wrong principal and inconsistent mutation receipts", async () => {
    const current = await admin(), mismatch = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mutationResponse(adminSource("Next", "9223372036854775807"), 200, team)));
    await expect(renameTeam(user, current, "Next", signal(), mismatch, vi.fn())).rejects.toMatchObject({ code: "principal_mismatch" }); expect(mismatch).toHaveBeenCalledOnce();
    for (const body of [adminSource("Next", "9223372036854775806"), adminSource("Wrong", "9223372036854775807"), adminSource("Next", "9223372036854775807").replace('"role":"admin"', '"role":"member"')]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mutationResponse(body)));
      await expect(renameTeam(user, current, "Next", signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mutationResponse(`{"teamId":"${team}","deleted":true,"extra":1}`)));
    await expect(deleteTeam(user, current, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
  });

  it("exposes known refusals and unknown outcomes without retrying", async () => {
    const current = await admin(), dispatch = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(mutationResponse('{"error":{"code":"team_not_empty","message":"not empty","requestId":"req"}}', 409)).mockRejectedValueOnce(new TypeError("connection lost")); vi.stubGlobal("fetch", fetch);
    await expect(deleteTeam(user, current, signal(), vi.fn(), dispatch)).rejects.toMatchObject({ kind: "server", code: "team_not_empty" });
    await expect(deleteTeam(user, current, signal(), vi.fn(), dispatch)).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("invalidates identity on a server identity mismatch", async () => {
    const mismatch = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mutationResponse('{"error":{"code":"identity_mismatch","message":"identity mismatch","requestId":"req"}}', 409)));
    await expect(createTeam(user, "Team", signal(), mismatch, vi.fn())).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce();
  });
  it("rejects invalid names and Personal before dispatch", async () => {
    const current = await admin(), dispatch = vi.fn(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const name of ["", " \n\t", "\0", "\ud800"]) expect(() => createTeam(user, name, signal(), vi.fn(), dispatch)).toThrow();
    expect(() => deleteTeam(user, { ...current, kind: "personal", name: null }, signal(), vi.fn(), dispatch)).toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
});
