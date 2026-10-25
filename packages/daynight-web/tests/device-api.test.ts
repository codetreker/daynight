import { describe, expect, it, vi } from "vitest";
import { decideDeviceAuthorization, inspectDeviceAuthorization } from "../src/api/auth";
import { normalizeDeviceUserCode } from "../src/api/auth-parse";
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from "../src/api/client";

const userId = "00000000-0000-4000-8000-000000000001";
const code = "BCDFG-HJKLM";
const expiresAt = "2026-10-25T07:00:00Z";
const signal = () => new AbortController().signal;
const mismatch = vi.fn();
const response = (value: unknown, status = 200, principal: string | null = userId) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const install = (value: Response) => { const fetcher = vi.fn().mockResolvedValue(value); vi.stubGlobal("fetch", fetcher); return fetcher; };

describe("device authorization API", () => {
  it("normalizes human input while rejecting ambiguous characters and control characters", () => {
    expect(normalizeDeviceUserCode(" bcdfg-hjklm ")).toBe(code);
    expect(normalizeDeviceUserCode("BCDFG HJKLM")).toBe(code);
    for (const invalid of ["", "ABCDE-FGHIJ", "BCDFG-HJKLY", "BCDFG\nHJKLM", "BCDFG-HJKLM-BCDFG"]) expect(normalizeDeviceUserCode(invalid)).toBeNull();
  });

  it.each(["pending", "approved", "denied", "expired", "consumed"])("inspects %s with same-origin credentials and account validation", async (status) => {
    const fetcher = install(response({ userCode: code, expiresAt, status }));
    const controller = new AbortController();
    await expect(inspectDeviceAuthorization(code, userId, controller.signal, mismatch)).resolves.toEqual({ userCode: code, expiresAt, status });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/device/inspect", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ userCode: code }),
      signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
    });
  });

  it.each(["approve", "deny"] as const)("sends one explicit %s decision without parsing a 204 body", async (decision) => {
    const fetcher = install(response(null, 204));
    await decideDeviceAuthorization(code, decision, userId, signal(), mismatch);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/auth/device/decision", expect.objectContaining({ method: "POST", body: JSON.stringify({ userCode: code, decision, expectedUserId: userId }) }));
  });

  it.each([
    { userCode: "HJKLM-BCDFG", expiresAt, status: "pending" }, { userCode: code, expiresAt: "wrong", status: "pending" }, { userCode: code, expiresAt, status: "unknown" },
  ])("rejects malformed or different-grant inspection responses", async (body) => {
    install(response(body));
    await expect(inspectDeviceAuthorization(code, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("invalidates a changed browser account before publishing the response", async () => {
    install(response({ userCode: code, expiresAt, status: "pending" }, 200, "00000000-0000-4000-8000-000000000002"));
    const changed = vi.fn();
    await expect(inspectDeviceAuthorization(code, userId, signal(), changed)).rejects.toMatchObject({ code: "principal_mismatch" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("rejects responses missing admitted identity and unexpected successful statuses", async () => {
    const fetcher = install(response({ userCode: code, expiresAt, status: "pending" }, 200, null));
    await expect(inspectDeviceAuthorization(code, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValue(response({}, 200));
    await expect(decideDeviceAuthorization(code, "approve", userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
    fetcher.mockResolvedValue(response({ userCode: code, expiresAt, status: "pending" }, 201));
    await expect(inspectDeviceAuthorization(code, userId, signal(), mismatch)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("preserves sanitized refusals without exposing server details or replaying a write", async () => {
    const fetcher = install(response({ error: { code: "invalid_transition", message: "private material", details: { secret: "private material" }, requestId: "device-rq" } }, 409));
    const failure = await decideDeviceAuthorization(code, "approve", userId, signal(), mismatch).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 409, code: "invalid_transition", requestId: "device-rq" });
    expect(JSON.stringify(failure)).not.toContain("private material");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("holds decisions behind identity confirmation and cancels them after account invalidation", async () => {
    const fetcher = install(response(null, 204));
    pauseAuthRequests();
    const pending = decideDeviceAuthorization(code, "approve", userId, signal(), mismatch);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    invalidateAuthRequests();
    await failure;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects noncanonical request codes before network dispatch", async () => {
    const fetcher = install(response(null, 204));
    await expect(inspectDeviceAuthorization("bcdfg-hjklm", userId, signal(), mismatch)).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
