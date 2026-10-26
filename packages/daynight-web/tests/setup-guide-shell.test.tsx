import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedApp, parseAuthRoute } from "../src/app/AuthenticatedApp";
import { SetupGuideShell } from "../src/features/setup/SetupGuideShell";
import { renderWithLocale } from "./helpers/renderWithLocale";
import { viewerHeaders } from "./helpers/taskSync";

const userId = "00000000-0000-4000-8000-000000000001";
const user = { id: userId, name: "Alice", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: viewerHeaders(userId, { "Content-Type": "application/json" }) });

beforeEach(() => {
  window.sessionStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

describe("public setup guide", () => {
  it("keeps the public guide out of the authenticated route parser", () => {
    expect(parseAuthRoute("/setup")).toEqual({ kind: "notFound" });
    expect(parseAuthRoute("/setup", "?ref=guide")).toEqual({ kind: "notFound" });
    expect(parseAuthRoute("/setup/elsewhere")).toEqual({ kind: "notFound" });
  });

  it("renders the guide, title, breadcrumb and language controls without checking identity", async () => {
    window.history.replaceState(null, "", "/setup?ref=welcome");
    const fetcher = vi.fn(() => { throw new Error("The public guide must not request any API"); });
    vi.stubGlobal("fetch", fetcher);
    const view = renderWithLocale(<SetupGuideShell />, { locale: "zh-CN" });
    expect(screen.getByRole("heading", { name: "连接工具，开始工作" })).toBeVisible();
    expect(document.title).toBe("使用引导 · Daynight");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(within(screen.getByRole("navigation", { name: "面包屑" })).getByText("使用引导")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: /^使用.+登录$|^退出登录$/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "语言 / Language" }), { target: { value: "en" } });
    expect(screen.getByRole("heading", { name: "Set up your tools and start working" })).toBeVisible();
    expect(document.title).toBe("Setup guide · Daynight");
    expect(document.documentElement.lang).toBe("en");
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Setup guide")).toHaveAttribute("aria-current", "page");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy: Install the Daynight CLI" })));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("npm install --global @codetreker/daynight\ndaynight --version");
    expect(screen.getByRole("status")).toHaveTextContent("Copied.");
    act(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe("/setup?ref=welcome");
    view.unmount();
    renderWithLocale(<SetupGuideShell />, { locale: "en" });
    expect(screen.getByRole("heading", { name: "Set up your tools and start working" })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses ordinary document links to leave the guide", () => {
    const fetcher = vi.fn(() => { throw new Error("The public guide must not request any API"); });
    vi.stubGlobal("fetch", fetcher);
    renderWithLocale(<SetupGuideShell />, { locale: "zh-CN" });
    const link = screen.getByRole("link", { name: "返回项目列表" });
    expect(link).toHaveAttribute("href", "/projects");
    expect(link).not.toHaveAttribute("target");
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens the header guide through a native new-tab link while preserving the authenticated workspace", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/v1/me") return json(user);
      if (url.startsWith("/api/v1/projects")) return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithLocale(<AuthenticatedApp />, { locale: "zh-CN" });
    await screen.findByRole("heading", { name: "项目" });
    expect(fetcher.mock.calls.map(([url]) => url)).toContain("/api/v1/me");
    const link = screen.getByRole("link", { name: "使用引导" });
    expect(link).toHaveAttribute("href", "/setup");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const selector = screen.getByRole("combobox", { name: "语言 / Language" });
    expect(link.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const before = fetcher.mock.calls.length;
    for (const options of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, options)).toBe(true);
    }
    expect(window.location.pathname).toBe("/projects");
    expect(screen.getByRole("heading", { name: "项目" })).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
});
