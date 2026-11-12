import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { invalidateAuthRequests } from "../src/api/client";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("zh-CN");
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: "00000000-0000-4000-8000-000000000001", name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const other = { ...user, id: "00000000-0000-4000-8000-000000000002", name: "Bob" };
const code = "BCDFG-HJKLM";
const inspection = () => ({ userCode: code, expiresAt: new Date(Date.now() + 600_000).toISOString(), status: "pending" });
const response = (body: unknown, status = 200, principal = user.id) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...(status === 401 ? {} : { "Daynight-User-ID": principal }) } });

beforeEach(() => {
  invalidateAuthRequests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  window.history.replaceState(null, "", `/device?user_code=${code}`);
});

describe("device authorization shell integration", () => {
  it("parses the device entry without treating duplicate query values as a code", () => {
    expect(parseAuthRoute("/device")).toEqual({ kind: "device", userCode: null });
    expect(parseAuthRoute("/device", `?user_code=${code}`)).toEqual({ kind: "device", userCode: code });
    expect(parseAuthRoute("/device", `?user_code=${code}&user_code=${code}`)).toEqual({ kind: "device", userCode: "" });
    expect(parseAuthRoute("/device/extra")).toEqual({ kind: "notFound" });
  });

  it("preserves device code through explicit browser login without approving the grant", async () => {
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? response({ error: { code: "unauthenticated", message: "Sign in", requestId: "device-login" } }, 401) : response({ providers: ["github"] })));
    vi.stubGlobal("fetch", fetcher);
    const login = vi.fn();
    render(<AuthenticatedApp navigateToLogin={login} />);
    fireEvent.click(await screen.findByRole("button", { name: "使用 GitHub 登录" }));
    const loginUrl = new URL(login.mock.calls[0]![0], window.location.origin);
    expect(loginUrl.searchParams.get("returnPath")).toBe(`/device?user_code=${code}`);
    expect(screen.getByText("登录后确认 Daynight CLI 显示的授权码。")).toBeInTheDocument();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me", "/api/v1/auth/providers"]);
  });

  it("waits for the current account and only writes after explicit comparison and approval", async () => {
    let finishIdentity!: (value: Response) => void;
    const fetcher = vi.fn((url: string) => {
      if (url === "/api/v1/me") return new Promise<Response>((resolve) => { finishIdentity = resolve; });
      return Promise.resolve(url.endsWith("/inspect") ? response(inspection()) : response(null, 204));
    });
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => finishIdentity(response(user)));
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "授权 CLI" }));
    await screen.findByRole("heading", { name: "CLI 已获授权" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me", "/api/v1/auth/device/inspect", "/api/v1/auth/device/decision"]);
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/auth/device/decision", expect.objectContaining({ body: JSON.stringify({ userCode: code, decision: "approve", expectedUserId: user.id }) }));
    expect(document.title).toBe("授权 CLI · Daynight");
  });

  it("retains the account and stops when the response belongs to another principal", async () => {
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? response(user) : response(inspection(), 200, other.id)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    await screen.findByText("账户已变化");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "授权 CLI" })).toBeNull();
    expect(fetcher.mock.calls.every(([url]) => !url.endsWith("/decision"))).toBe(true);
  });

  it("retains the selected code and blocks approval after a shared account change", async () => {
    const fetcher = vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? response(user) : response(inspection(), 200, user.id)));
    vi.stubGlobal("fetch", fetcher); render(<AuthenticatedApp />);
    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);
    act(() => {
      localStorage.setItem("daynight.activeUser", JSON.stringify(other.id));
      window.dispatchEvent(new StorageEvent("storage", { key: "daynight.activeUser" }));
    });
    await screen.findByText("账户已变化");
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "授权 CLI" }));
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
    expect(fetcher.mock.calls.every(([url]) => !url.endsWith("/decision"))).toBe(true);
  });
});
