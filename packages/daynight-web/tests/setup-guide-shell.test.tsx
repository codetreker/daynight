import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
import { renderWithLocale } from "./helpers/renderWithLocale";
import { viewerHeaders } from "./helpers/taskSync";

const userId = "00000000-0000-4000-8000-000000000001";
const user = { id: userId, name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: status === 401 ? { "Content-Type": "application/json" } : viewerHeaders(userId, { "Content-Type": "application/json" }) });
const install = () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/v1/me") return json(user);
    if (url.startsWith("/api/v1/projects")) return json({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

beforeEach(() => {
  window.sessionStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

describe("authenticated setup route", () => {
  it("accepts the exact page route and preserves other routing rules", () => {
    expect(parseAuthRoute("/setup")).toEqual({ kind: "setup" });
    expect(parseAuthRoute("/setup", "?ref=guide")).toEqual({ kind: "setup" });
    expect(parseAuthRoute("/setup/elsewhere")).toEqual({ kind: "notFound" });
  });

  it("loads directly with identity verification only, localized title and a visible link before the language selector", async () => {
    window.history.replaceState(null, "", "/setup");
    const fetcher = install();
    const view = renderWithLocale(<AuthenticatedApp />, { locale: "zh-CN" });
    await screen.findByRole("heading", { name: "连接工具，开始工作" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me"]);
    expect(document.title).toBe("使用引导 · Daynight");
    const link = screen.getByRole("link", { name: "使用引导" });
    expect(link).toHaveAttribute("href", "/setup");
    expect(link).toHaveAttribute("aria-current", "page");
    const selector = screen.getByRole("combobox", { name: "语言 / Language" });
    expect(link.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(screen.getByRole("navigation", { name: "面包屑" })).getByText("使用引导")).toHaveAttribute("aria-current", "page");
    view.setLocale("en");
    expect(document.title).toBe("Setup guide · Daynight");
    expect(screen.getByRole("link", { name: "Setup guide" })).toHaveAttribute("aria-current", "page");
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.unmount();
    renderWithLocale(<AuthenticatedApp />, { locale: "en" });
    await screen.findByRole("heading", { name: "Set up your tools and start working" });
    expect(window.location.pathname).toBe("/setup");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me", "/api/v1/me"]);
  });

  it("uses real links for entry and return, preserving modified clicks and popstate navigation", async () => {
    const fetcher = install();
    renderWithLocale(<AuthenticatedApp />, { locale: "zh-CN" });
    await screen.findByRole("heading", { name: "项目" });
    const link = screen.getByRole("link", { name: "使用引导" });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(fireEvent.click(link, { shiftKey: true })).toBe(true);
    expect(fireEvent.click(link, { altKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(window.location.pathname).toBe("/");
    fireEvent.click(link);
    await screen.findByRole("heading", { name: "连接工具，开始工作" });
    expect(window.location.pathname).toBe("/setup");
    const before = fetcher.mock.calls.length;
    act(() => { window.history.replaceState(null, "", "/setup"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(fetcher).toHaveBeenCalledTimes(before);
    fireEvent.click(screen.getByRole("link", { name: "返回项目列表" }));
    await screen.findByRole("heading", { name: "项目" });
    expect(window.location.pathname).toBe("/");
    act(() => navigate("/setup"));
    await screen.findByRole("heading", { name: "连接工具，开始工作" });
    expect(document.activeElement).toBe(screen.getByRole("main"));
    await waitFor(() => expect(screen.getByRole("link", { name: "使用引导" })).toHaveAttribute("aria-current", "page"));
  });

  it("retains the setup destination through the existing sign-in flow", async () => {
    window.history.replaceState(null, "", "/setup?ref=welcome");
    const navigateToLogin = vi.fn();
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/v1/me") return json({ error: { code: "unauthorized", message: "Sign in", requestId: "login-guide" } }, 401);
      if (url === "/api/v1/auth/providers") return json({ providers: ["github"] });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithLocale(<AuthenticatedApp navigateToLogin={navigateToLogin} />, { locale: "zh-CN" });
    fireEvent.click(await screen.findByRole("button", { name: "使用 GitHub 登录" }));
    await waitFor(() => expect(navigateToLogin).toHaveBeenCalledTimes(1));
    const target = new URL(navigateToLogin.mock.calls[0]![0]!, window.location.origin);
    expect(target.pathname).toBe("/api/v1/auth/login");
    expect(target.searchParams.get("returnPath")).toBe("/setup?ref=welcome");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me", "/api/v1/auth/providers"]);
  });
});
