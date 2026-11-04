import { afterEach, describe, expect, it, vi } from "vitest";
import { getTeam, listTeams } from "../src/api/teams";
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
});
