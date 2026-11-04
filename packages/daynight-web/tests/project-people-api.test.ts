import { afterEach, describe, expect, it, vi } from "vitest";
import { listProjectPeople } from "../src/api/auth";
import { ApiError, invalidateAuthRequests } from "../src/api/client";

const projectId = "10000000-0000-4000-8000-000000000001";
const viewerId = "20000000-0000-4000-8000-000000000002";
const personId = "30000000-0000-4000-8000-000000000003";
const otherId = "40000000-0000-4000-8000-000000000004";
const person = { version: "a".repeat(64), userId: personId, name: null, avatarUrl: null, hasProjectAccess: false };
const signal = () => new AbortController().signal;
const admission = () => ({ userId: viewerId, onPrincipalMismatch: vi.fn() });
const response = (body: unknown, principal: string | null = viewerId, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) },
});
const mock = (body: unknown) => { const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(body))); vi.stubGlobal("fetch", fetcher); return fetcher; };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("project task assignee API", () => {
  it("keeps catalogue and bounded lookup distinct with the exact minimal person shape", async () => {
    const fetcher = mock({ items: [person], unresolvedUserIds: [] });
    const expected = { items: [person], unresolvedUserIds: [] };
    await expect(listProjectPeople(projectId, { kind: "catalogue" }, signal(), admission())).resolves.toEqual(expected);
    expect(fetcher.mock.calls[0]).toEqual([`/api/v1/projects/${projectId}/task-assignees`, expect.objectContaining({ headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin" })]);
    await expect(listProjectPeople(projectId, { kind: "resolve", userIds: [personId] }, signal(), admission())).resolves.toEqual(expected);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/v1/projects/${projectId}/task-assignees?userId=${personId}`);
  });

  it.each(["email", "role", "externalIdentity", "unexpected"])("rejects the unexpected person field %s in catalogue and bounded responses", async (field) => {
    mock({ items: [{ ...person, [field]: "private" }], unresolvedUserIds: [] });
    for (const query of [{ kind: "catalogue" }, { kind: "resolve", userIds: [personId] }] as const) {
      await expect(listProjectPeople(projectId, query, signal(), admission())).rejects.toThrow("invalid response");
    }
  });

  it.each(["email", "role", "externalIdentity", "unexpected"])("rejects the unexpected envelope field %s in catalogue and bounded responses", async (field) => {
    mock({ items: [person], unresolvedUserIds: [], [field]: "private" });
    for (const query of [{ kind: "catalogue" }, { kind: "resolve", userIds: [personId] }] as const) {
      await expect(listProjectPeople(projectId, query, signal(), admission())).rejects.toThrow("invalid response");
    }
  });

  it("retains nullable profiles and explicit unresolved IDs without inventing access loss", async () => {
    mock({ items: [person], unresolvedUserIds: [otherId] });
    await expect(listProjectPeople(projectId, { kind: "resolve", userIds: [personId, otherId] }, signal(), admission())).resolves.toEqual({ items: [person], unresolvedUserIds: [otherId] });
  });

  it.each([[], [personId, personId], Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`)].map((userIds) => ({ userIds })))("rejects an invalid bounded request before network I/O %#", ({ userIds }) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(() => listProjectPeople(projectId, { kind: "resolve", userIds }, signal(), admission())).toThrow(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { items: null, unresolvedUserIds: [] },
    { items: [], unresolvedUserIds: null },
    { items: [], unresolvedUserIds: [] },
    { items: [person, person], unresolvedUserIds: [] },
    { items: [person], unresolvedUserIds: [personId] },
    { items: [{ ...person, userId: "invalid" }], unresolvedUserIds: [] },
    { items: [{ ...person, name: undefined }], unresolvedUserIds: [] },
    { items: [{ ...person, avatarUrl: undefined }], unresolvedUserIds: [] },
    { items: [{ ...person, version: undefined }], unresolvedUserIds: [] },
    { items: [{ ...person, version: "A".repeat(64) }], unresolvedUserIds: [] },
    { items: [{ ...person, version: "a".repeat(63) }], unresolvedUserIds: [] },
    { items: [{ ...person, hasProjectAccess: undefined }], unresolvedUserIds: [] },
    { items: [{ ...person, hasProjectAccess: "false" }], unresolvedUserIds: [] },
    { items: [{ ...person, userId: otherId }], unresolvedUserIds: [] },
  ])("rejects malformed or inexact bounded partitions %#", async (body) => {
    mock(body);
    await expect(listProjectPeople(projectId, { kind: "resolve", userIds: [personId] }, signal(), admission())).rejects.toThrow("invalid response");
  });

  it("rejects unresolved catalogue entries", async () => {
    mock({ items: [], unresolvedUserIds: [personId] });
    await expect(listProjectPeople(projectId, { kind: "catalogue" }, signal(), admission())).rejects.toThrow("invalid response");
  });

  it.each([null, "invalid", otherId])("checks response identity before accepting either success or denial %#", async (principal) => {
    const fetcher = vi.fn().mockResolvedValue(response({ items: [person], unresolvedUserIds: [] }, principal)); vi.stubGlobal("fetch", fetcher);
    const admit = admission();
    await expect(listProjectPeople(projectId, { kind: "catalogue" }, signal(), admit)).rejects.toMatchObject({ kind: "protocol" });
    expect(admit.onPrincipalMismatch).toHaveBeenCalledTimes(principal === otherId ? 1 : 0);
    fetcher.mockResolvedValue(response({ error: { code: "not_found", message: "private", requestId: "people-denial" } }, principal, 404));
    await expect(listProjectPeople(projectId, { kind: "catalogue" }, signal(), admit)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("sanitizes trusted parent-project denials", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: { code: "not_found", message: "private", requestId: "people-denial", details: { secret: "private" } } }, viewerId, 404)); vi.stubGlobal("fetch", fetcher);
    await expect(listProjectPeople(projectId, { kind: "catalogue" }, signal(), admission())).rejects.toMatchObject({ kind: "server", status: 404, code: "not_found", requestId: "people-denial" });
  });
});
