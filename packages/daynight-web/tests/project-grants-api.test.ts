import { afterEach, describe, expect, it, vi } from "vitest";
import { removeProjectGrant, setProjectGrant } from "../src/api/auth";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { directAccessFixture } from "./helpers/taskSync";

const projectId = "10000000-0000-0000-0000-00000000000a";
const actorId = "20000000-0000-0000-0000-00000000000b";
const targetId = "30000000-0000-0000-0000-00000000000c";
const time = "2026-10-22T12:34:56Z";
const version = 9_007_199_254_740_993n;
const grant = { projectId, userId: targetId, role: "member", version, createdAt: time, updatedAt: time };
const actorAccess = { ...directAccessFixture(projectId, actorId, "admin"), ownership: { teamId: "00000000-0000-4000-8000-000000000701", version }, directGrant: { ...directAccessFixture(projectId, actorId, "admin").directGrant!, version } };
const signal = () => new AbortController().signal;
const rawJson = JSON as unknown as { rawJSON: (text: string) => unknown };
const response = (value: unknown, status = 200, principal = actorId) => new Response(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? rawJson.rawJSON(item.toString()) : item), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const mock = (value: Response) => { const fetcher = vi.fn().mockResolvedValue(value); vi.stubGlobal("fetch", fetcher); return fetcher; };
afterEach(() => { vi.unstubAllGlobals(); invalidateAuthRequests(); });

describe("project grant receipts", () => {
  it.each(["set", "remove"] as const)("reports %s dispatch only when fetch starts, not when admission is cancelled", async (action) => {
    const fetcher = mock(action === "set" ? response({ grant, actorAccess }) : response({ projectId, userId: targetId, deleted: true, actorAccess }));
    const dispatch = vi.fn();
    const controller = new AbortController();
    const resume = pauseAuthRequests();
    const invoke = (requestSignal: AbortSignal) => action === "set"
      ? setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, requestSignal, vi.fn(), dispatch)
      : removeProjectGrant(projectId, targetId, { version, expectedUserId: actorId }, requestSignal, vi.fn(), dispatch);
    const pending = invoke(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    resume();
    fetcher.mockImplementationOnce(async () => {
      expect(dispatch).toHaveBeenCalledOnce();
      return action === "set" ? response({ grant, actorAccess }) : response({ projectId, userId: targetId, deleted: true, actorAccess });
    });
    await invoke(signal());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("reports a dispatched request before propagating network cancellation", async () => {
    const dispatched = vi.fn();
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(dispatched).toHaveBeenCalledOnce();
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, controller.signal, vi.fn(), dispatched);
    expect(fetcher).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("creates with null, replaces with an exact numeric version and preserves nested int64 values", async () => {
    const fetcher = mock(response({ grant, actorAccess }));
    expect(await setProjectGrant(projectId, targetId, { version: null, role: "member", expectedUserId: actorId }, signal(), vi.fn())).toEqual({ grant, actorAccess });
    expect(fetcher.mock.calls[0]).toEqual([`/api/v1/projects/${projectId}/grants/${targetId}`, expect.objectContaining({ method: "PUT", body: `{"version":null,"role":"member","expectedUserId":"${actorId}"}` })]);
    fetcher.mockResolvedValue(response({ grant, actorAccess }));
    await setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn());
    expect(fetcher.mock.calls[1]?.[1].body).toBe(`{"version":9007199254740993,"role":"member","expectedUserId":"${actorId}"}`);
  });

  it("accepts a self-removal receipt with null access and sends the observed version", async () => {
    const fetcher = mock(response({ projectId, userId: actorId, deleted: true, actorAccess: null }));
    expect(await removeProjectGrant(projectId, actorId, { version, expectedUserId: actorId }, signal(), vi.fn())).toEqual({ projectId, userId: actorId, deleted: true, actorAccess: null });
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "DELETE", body: `{"version":9007199254740993,"expectedUserId":"${actorId}"}` }));
  });

  it("preserves Team admin access after self grant changes", async () => {
    const selfGrant = { ...grant, userId: actorId };
    const inherited = { ...actorAccess, teamRole: "admin", canTransfer: true, directGrant: selfGrant };
    const fetcher = mock(response({ grant: selfGrant, actorAccess: inherited }));
    expect((await setProjectGrant(projectId, actorId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).actorAccess?.effectiveRole).toBe("admin");
    fetcher.mockResolvedValue(response({ projectId, userId: actorId, deleted: true, actorAccess: { ...inherited, directGrant: null } }));
    expect((await removeProjectGrant(projectId, actorId, { version, expectedUserId: actorId }, signal(), vi.fn())).actorAccess?.effectiveRole).toBe("admin");
  });

  it("accepts post-write access changes independently of the earlier authorization", async () => {
    const memberAccess = directAccessFixture(projectId, actorId, "member");
    const fetcher = mock(response({ grant, actorAccess: memberAccess }));
    expect((await setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).actorAccess).toEqual(memberAccess);
    fetcher.mockResolvedValue(response({ projectId, userId: targetId, deleted: true, actorAccess: null }));
    expect((await removeProjectGrant(projectId, targetId, { version, expectedUserId: actorId }, signal(), vi.fn())).actorAccess).toBeNull();
    fetcher.mockResolvedValue(response({ grant, actorAccess: null }));
    expect((await setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).actorAccess).toBeNull();
  });

  it.each([
    { grant: { ...grant, userId: actorId }, actorAccess },
    { grant: { ...grant, role: "admin" }, actorAccess },
    { grant: { ...grant, version: version - 1n }, actorAccess },
    { grant, actorAccess, unexpected: true },
  ])("rejects malformed or inconsistent set receipts %#", async (value) => {
    mock(response(value));
    await expect(setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it.each([
    { projectId, userId: targetId, deleted: false, actorAccess },
    { projectId, userId: actorId, deleted: true, actorAccess },
    { projectId, userId: targetId, deleted: true },
  ])("rejects malformed or inconsistent deletion receipts %#", async (value) => {
    mock(response(value));
    await expect(removeProjectGrant(projectId, targetId, { version, expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it("rejects a self receipt inconsistent with the actor's direct grant", async () => {
    const selfGrant = { ...grant, userId: actorId };
    const fetcher = mock(response({ grant: selfGrant, actorAccess }));
    await expect(setProjectGrant(projectId, actorId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
    fetcher.mockResolvedValue(response({ grant: selfGrant, actorAccess: null }));
    await expect(setProjectGrant(projectId, actorId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
    fetcher.mockResolvedValue(response({ projectId, userId: actorId, deleted: true, actorAccess }));
    await expect(removeProjectGrant(projectId, actorId, { version, expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it("rejects wrong principals and reports an explicit identity mismatch without replay", async () => {
    const mismatch = vi.fn(), fetcher = mock(response({ grant, actorAccess }, 200, targetId));
    await expect(setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValue(response({ error: { code: "identity_mismatch", message: "identity", requestId: "request-1" } }, 409));
    await expect(removeProjectGrant(projectId, targetId, { version, expectedUserId: actorId }, signal(), mismatch)).rejects.toMatchObject({ kind: "server", code: "identity_mismatch" });
    expect(mismatch).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["0", "1.0", "1e3", "9223372036854775808", '"9007199254740993"'])("rejects invalid grant response version %s", async (invalid) => {
    const encoded = JSON.stringify({ grant: { ...grant, version: 123 }, actorAccess }, (_key, item: unknown) => typeof item === "bigint" ? rawJson.rawJSON(item.toString()) : item).replace('"version":123', `"version":${invalid}`);
    mock(new Response(encoded, { headers: { "Content-Type": "application/json", "Daynight-User-ID": actorId } }));
    await expect(setProjectGrant(projectId, targetId, { version: null, role: "member", expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol", status: 200 });
  });

  it.each([[409, "version_conflict"], [503, "write_outcome_unknown"]] as const)("exposes %s %s without replay", async (status, code) => {
    const fetcher = mock(response({ error: { code, message: "failure", requestId: "request-1" } }, status));
    await expect(setProjectGrant(projectId, targetId, { version, role: "member", expectedUserId: actorId }, signal(), vi.fn())).rejects.toMatchObject({ kind: "server", status, code, requestId: "request-1" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])("rejects an invalid version %s before dispatch", (invalid) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(() => setProjectGrant(projectId, targetId, { version: invalid, role: "member", expectedUserId: actorId }, signal(), vi.fn())).toThrow();
    expect(() => removeProjectGrant(projectId, targetId, { version: invalid, expectedUserId: actorId }, signal(), vi.fn())).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
