import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";
import { listOwnerGrants, revokeOwnerGrant } from "../src/api/oauth-grants";

const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000003";
const grant = { id: "00000000-0000-4000-8000-000000000002", clientName: "Client", clientId: "https://client.test", resource: "https://daynight.cc/mcp", scope: "daynight:mcp", createdAt: "2026-10-25T10:00:00Z", expiresAt: "2099-10-25T10:00:00Z", revokedAt: null, status: "active" };
const signal = () => new AbortController().signal;
const response = (body: unknown, principal: string | null = user, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const install = (value: Response) => { const fetcher = vi.fn().mockResolvedValue(value); vi.stubGlobal("fetch", fetcher); return fetcher; };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe("owner OAuth grant API", () => {
  it("reads only the reviewed account and sends its identity when revoking", async () => {
    const fetcher = install(response({ userId: user, grants: [grant] }));
    await expect(listOwnerGrants(signal(), user, vi.fn())).resolves.toEqual([grant]);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/oauth/grants", expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }));
    fetcher.mockResolvedValue(response({ changed: true }));
    await expect(revokeOwnerGrant(grant.id, user, signal(), vi.fn())).resolves.toBe(true);
    expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/oauth/grants/${grant.id}/revoke`, expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedUserId: user }) }));
  });
  it.each([null, other])("rejects a missing or changed response principal: %s", async (principal) => {
    install(response({ userId: user, grants: [] }, principal));
    const mismatch = vi.fn();
    await expect(listOwnerGrants(signal(), user, mismatch)).rejects.toMatchObject({ kind: "protocol" });
    expect(mismatch).toHaveBeenCalledTimes(principal === null ? 0 : 1);
  });
  it("rejects a different page account, duplicates, malformed fields, and inconsistent revocation", async () => {
    const fetcher = install(response({ userId: other, grants: [grant] }));
    await expect(listOwnerGrants(signal(), user, vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    for (const grants of [[grant, grant], [{ ...grant, expiresAt: "bad" }], [{ ...grant, status: "revoked" }], [{ ...grant, secret: "not-allowed" }]]) {
      fetcher.mockResolvedValue(response({ userId: user, grants }));
      await expect(listOwnerGrants(signal(), user, vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    }
  });
  it("rejects malformed or wrong-principal receipts without replaying the POST", async () => {
    const fetcher = install(response({ changed: "yes" }));
    await expect(revokeOwnerGrant(grant.id, user, signal(), vi.fn())).rejects.toMatchObject({ kind: "protocol" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(response({ changed: true }, other));
    const mismatch = vi.fn();
    await expect(revokeOwnerGrant(grant.id, user, signal(), mismatch)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("holds a write behind identity checks and cancels it on account replacement", async () => {
    const fetcher = install(response({ changed: true })); pauseAuthRequests();
    const dispatched = vi.fn();
    const pending = revokeOwnerGrant(grant.id, user, signal(), vi.fn(), dispatched);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled(); expect(dispatched).not.toHaveBeenCalled(); invalidateAuthRequests(); await cancelled;
    expect(fetcher).not.toHaveBeenCalled(); expect(dispatched).not.toHaveBeenCalled();
  });
  it("reports dispatch only when the request passes the gate, before fetch", async () => {
    const order: string[] = [];
    const resume = pauseAuthRequests();
    const fetcher = vi.fn().mockImplementation(() => { order.push("fetch"); return Promise.resolve(response({ changed: true })); });
    vi.stubGlobal("fetch", fetcher);
    const pending = revokeOwnerGrant(grant.id, user, signal(), vi.fn(), () => { order.push("dispatch"); });
    expect(order).toEqual([]);
    resume();
    await expect(pending).resolves.toBe(true);
    expect(order).toEqual(["dispatch", "fetch"]);
  });
});
