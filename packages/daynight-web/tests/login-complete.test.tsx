import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginCompletePage } from "../src/features/auth/LoginCompletePage";
import { parseLoginCompletionTarget } from "../src/features/auth/login-completion";
import { renderWithLocale } from "./helpers/renderWithLocale";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const KEY = "daynight.activeUser";
const user = { id: A, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: A, kind: "personal", name: null } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const query = (target: string) => `?returnPath=${encodeURIComponent(target)}`;

class Channel extends EventTarget {
  static instances: Channel[] = [];
  static openError = false;
  postMessage = vi.fn<(message: unknown) => void>();
  close = vi.fn();
  constructor(_name: string) {
    super();
    if (Channel.openError) throw new Error("channel unavailable");
    Channel.instances.push(this);
  }
}

beforeEach(() => {
  localStorage.clear();
  Channel.instances = [];
  Channel.openError = false;
  vi.stubGlobal("BroadcastChannel", Channel);
});

describe("completion return target", () => {
  it.each(["/", "/setup?source=login#guide", "/projects/one?value=%2F&x=1#detail", "/download/file?encoded=%252F#part", "/auth/complete%3Fok", "/auth/complete%23ok", `/${"é".repeat(2047)}a`])("preserves a safe complete target %s", (target) => {
    expect(parseLoginCompletionTarget(query(target), "")).toBe(target);
  });

  it.each([
    ["", ""], ["?returnPath=%2F&returnPath=%2Fsetup", ""], ["?returnPath=%2F&other=1", ""],
    [query("/"), "#fragment"], [query(""), ""], [query("https://example.com"), ""], [query("//example.com/path"), ""],
    [query("/bad\\path"), ""], [query("/bad\rpath"), ""], [query("/bad\npath"), ""], [query("/bad\0path"), ""],
    [query("/bad%5cpath"), ""], [query("/bad%0dpath"), ""], [query("/bad%0apath"), ""], [query("/bad%00path"), ""],
    [query("/auth/complete"), ""], [query("/auth/complete/child"), ""], [query("/auth//complete"), ""], [query("/auth//../complete"), ""], [query("/auth/\tcomplete"), ""], [query("/auth///complete/child"), ""], [query("/auth/%63omplete"), ""],
    [query("/other/../auth/complete"), ""], [query("/foo%3f/../auth/complete"), ""], [query("/foo%23/../auth/complete/child"), ""], [query("/auth/complete%2Fchild"), ""],
    [query(`/${"é".repeat(2048)}`), ""],
  ])("rejects unsafe completion query %s and fragment %s", (search, hash) => {
    expect(parseLoginCompletionTarget(search, hash)).toBeNull();
  });
});


describe("login completion", () => {
  const mount = (target = "/setup?from=login#guide") => {
    history.replaceState(null, "", `/auth/complete${query(target)}`);
    const replace = vi.fn();
    const view = renderWithLocale(<LoginCompletePage replace={replace} />, { locale: "en" });
    return { ...view, replace };
  };

  it("waits for the server identity and local publication before replacing the complete target", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const target = "/setup?from=%252F&tab=1#guide";
    const { replace } = mount(target);
    expect(screen.getByText("Confirming your account…")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(response(user)); await pending.promise; });
    await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(target));
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(A));
    expect(Channel.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); Channel.instances[0]!.dispatchEvent(new MessageEvent("message", { data: "identity-changed" })); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid entry without reading an identity", () => {
    history.replaceState(null, "", "/auth/complete?returnPath=%2F&extra=1");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const replace = vi.fn(); renderWithLocale(<LoginCompletePage replace={replace} />, { locale: "en" });
    expect(screen.getByRole("heading", { name: "This sign-in destination is invalid" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open sign-in" })).toHaveAttribute("href", "/login");
    expect(fetcher).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });

  it("rejects an empty fragment on the completion URL", () => {
    history.replaceState(null, "", `/auth/complete${query("/")}#`);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    renderWithLocale(<LoginCompletePage />, { locale: "en" });
    expect(screen.getByRole("heading", { name: "This sign-in destination is invalid" })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("only retries the identity read after a network failure", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(response(user));
    vi.stubGlobal("fetch", fetcher);
    const { replace } = mount();
    expect(await screen.findByText("Sign-in status could not be checked")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check your connection and try again." }));
    await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/setup?from=login#guide"));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/me", "/api/v1/me"]);
  });

  it("shows expired sign-in for an anonymous response and never navigates as a success", async () => {
    const fetcher = vi.fn(async () => response({ error: { code: "unauthenticated", message: "Sign in", requestId: "request" } }, 401));
    vi.stubGlobal("fetch", fetcher);
    const { replace } = mount();
    expect(await screen.findByText("Your session has expired. Sign in again to access your projects.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open sign-in" })).toHaveAttribute("href", "/login");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("retries a failed local write without rechecking identity", async () => {
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === KEY) throw new Error("write blocked");
      original.call(this, key, value);
    });
    const fetcher = vi.fn(async () => response(user)); vi.stubGlobal("fetch", fetcher);
    const { replace } = mount();
    expect(await screen.findByText("Sign-in completed, but account synchronization failed.")).toBeVisible();
    expect(localStorage.getItem(KEY)).toBeNull(); expect(replace).not.toHaveBeenCalled();
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Retry account synchronization" }));
    await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/setup?from=login#guide"));
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(A));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a failed broadcast only, preserving the already written value", async () => {
    Channel.openError = true;
    const fetcher = vi.fn(async () => response(user)); vi.stubGlobal("fetch", fetcher);
    const { replace } = mount();
    expect(await screen.findByText("Sign-in completed, but account synchronization failed.")).toBeVisible();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(A)); expect(replace).not.toHaveBeenCalled();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    Channel.openError = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry account synchronization" }));
    await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith("/setup?from=login#guide"));
    expect(writes).not.toHaveBeenCalled();
    expect(Channel.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("leaves a superseded pending publication in place and exposes the refresh action without stealing focus", async () => {
    Channel.openError = true;
    const fetcher = vi.fn(async () => response(user)); vi.stubGlobal("fetch", fetcher);
    const { replace } = mount();
    expect(await screen.findByText("Sign-in completed, but account synchronization failed.")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry account synchronization" });
    const language = screen.getByRole("combobox");
    language.focus();
    localStorage.setItem(KEY, JSON.stringify(B));
    Channel.openError = false;
    fireEvent.click(retry);
    expect(await screen.findByText("Account changed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh page" })).toBeVisible();
    expect(language).toHaveFocus();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
    expect(Channel.instances).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(replace).not.toHaveBeenCalled();
  });

  it("does not navigate on a superseded pending identity read", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => pending.promise); vi.stubGlobal("fetch", fetcher);
    const { replace } = mount();
    localStorage.setItem(KEY, JSON.stringify(B));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
    await act(async () => { pending.resolve(response(user)); await pending.promise; });
    expect(await screen.findByText("Account changed")).toBeVisible();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
    expect(Channel.instances[0]!.postMessage).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(replace).not.toHaveBeenCalled();
  });
});
