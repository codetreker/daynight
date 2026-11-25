import { afterEach, expect, it, vi } from "vitest";
import { invalidateAuthRequests } from "../src/api/client";
import { getTeamSettings, saveTeamSettings } from "../src/api/team-settings";

const user = "00000000-0000-4000-8000-000000000001";
const team = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const signal = () => new AbortController().signal;
const response = (body: string, status = 200, principal: string | null = user, contentType = "application/json") => new Response(body, {
  status, headers: { "Content-Type": contentType, ...(principal === null ? {} : { "Daynight-User-ID": principal }) },
});
const errorBody = (code: string) => JSON.stringify({ error: { code, message: "Unavailable", requestId: "request" } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reads the independent resource with its exact version", async () => {
  const fetch = vi.fn().mockResolvedValue(response('{"version":9223372036854775807,"allowNestedSubtask":false}'));
  vi.stubGlobal("fetch", fetch);
  await expect(getTeamSettings(team, user, signal(), vi.fn())).resolves.toEqual({ kind: "available", settings: { version: 9223372036854775807n, allowNestedSubtask: false } });
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/teams/${team}/settings`);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: "no-store", headers: { Accept: "application/json" } });
});

it.each([
  '{}', '{"version":1}', '{"version":1,"allowNestedSubtask":null}', '{"version":1,"allowNestedSubtask":false,"extra":true}',
  '{"version":0,"allowNestedSubtask":false}', '{"version":9223372036854775808,"allowNestedSubtask":false}',
  '{"version":1.0,"allowNestedSubtask":false}', '{"version":"1","allowNestedSubtask":false}',
])("rejects malformed settings %s", async body => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
  await expect(getTeamSettings(team, user, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
});

it("only recognizes the old unauthenticated JSON router 404 as unavailable", async () => {
  const mismatch = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(errorBody("not_found"), 404, null)));
  await expect(getTeamSettings(team, user, signal(), mismatch)).resolves.toEqual({ kind: "unavailable" });
  expect(mismatch).not.toHaveBeenCalled();
});

it.each([
  [404, user, "application/json", "not_found", "server"],
  [403, user, "application/json", "forbidden", "server"],
  [404, null, "text/html", "not_found", "protocol"],
  [404, null, "application/json", "forbidden", "server"],
] as const)("preserves other refusals and malformed responses %#", async (status, principal, contentType, code, kind) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(errorBody(code), status, principal, contentType)));
  await expect(getTeamSettings(team, user, signal(), vi.fn())).rejects.toMatchObject({ kind, status });
});

it("rejects a different response identity before reading the body", async () => {
  const result = response('{"version":1,"allowNestedSubtask":false}', 200, other);
  const text = vi.spyOn(result, "text"), mismatch = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result));
  await expect(getTeamSettings(team, user, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
  expect(mismatch).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
});

it.each([
  [false, true, '9223372036854775806', '9223372036854775807'],
  [true, true, '9223372036854775807', '9223372036854775807'],
] as const)("serializes the exact version and verifies changed and unchanged receipts %#", async (previous, next, version, resultVersion) => {
  const fetch = vi.fn().mockResolvedValue(response(`{"version":${resultVersion},"allowNestedSubtask":${next}}`));
  const dispatch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(saveTeamSettings(team, user, { version: BigInt(version), allowNestedSubtask: previous }, next, signal(), vi.fn(), dispatch)).resolves.toEqual({ version: BigInt(resultVersion), allowNestedSubtask: next });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/teams/${team}/settings`);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PATCH", body: `{"version":${version},"expectedUserId":"${user}","allowNestedSubtask":${next}}` });
});

it.each([
  '{"version":7,"allowNestedSubtask":true}', '{"version":9,"allowNestedSubtask":true}', '{"version":8,"allowNestedSubtask":false}',
])("rejects a mismatched write receipt %s", async body => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
  await expect(saveTeamSettings(team, user, { version: 7n, allowNestedSubtask: false }, true, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
});

it("preserves conflict and signals server identity mismatch", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(errorBody("version_conflict"), 409)).mockResolvedValueOnce(response(errorBody("identity_mismatch"), 403));
  const mismatch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const save = () => saveTeamSettings(team, user, { version: 7n, allowNestedSubtask: false }, true, signal(), mismatch, vi.fn());
  await expect(save()).rejects.toMatchObject({ kind: "server", code: "version_conflict" });
  await expect(save()).rejects.toMatchObject({ kind: "server", code: "identity_mismatch" });
  expect(mismatch).toHaveBeenCalledOnce();
});
