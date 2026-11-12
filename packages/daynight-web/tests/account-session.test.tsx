import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request, readAuthRequestGeneration } from "../src/api/client";
import { AccountSessionProvider, useAccountSession } from "../src/app/AccountSessionProvider";

const KEY = "daynight.activeUser";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const user = (id: string) => ({ id, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: A, kind: "personal", name: null } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const unauthorized = () => response({ error: { code: "unauthenticated", message: "Sign in", requestId: "request" } }, 401);

class Channel extends EventTarget {
  static instances: Channel[] = [];
  static openError: unknown;
  postMessage = vi.fn<(message: unknown) => void>();
  close = vi.fn();
  constructor(name: string) {
    super();
    if (name === "daynight-identity" && Channel.openError) throw Channel.openError;
    if (name === "daynight-identity") Channel.instances.push(this);
  }
  emit() { this.dispatchEvent(new MessageEvent("message", { data: "identity-changed" })); }
}

function Consumer() {
  const { session, sync, requiresRefresh, retryInitialization, retryPublication, signOut } = useAccountSession();
  return <>
    <output data-testid="session">{session.status === "authenticated" ? `${session.status}:${session.user.id}:${session.generation}` : session.status}</output>
    <output data-testid="refresh">{String(requiresRefresh)}</output>
    <output data-testid="sync">{sync.status === "error" ? `${sync.issue.phase}:${sync.persisted}` : sync.status}</output>
    <output data-testid="cause">{sync.status === "error" && sync.issue.cause instanceof Error ? sync.issue.cause.message : ""}</output>
    <button onClick={retryInitialization}>initialize</button><button onClick={retryPublication}>publish</button><button onClick={() => signOut()}>sign out</button>
  </>;
}
const mount = () => render(<AccountSessionProvider><Consumer /></AccountSessionProvider>);
const session = () => screen.getByTestId("session").textContent;
const sync = () => screen.getByTestId("sync").textContent;
const refresh = () => screen.getByTestId("refresh").textContent;
const notify = (id: string | null) => {
  localStorage.setItem(KEY, JSON.stringify(id));
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
};

beforeEach(() => {
  Channel.instances = [];
  Channel.openError = undefined;
  vi.stubGlobal("BroadcastChannel", Channel);
});

describe("account session owner", () => {
  it("initializes once from the server, replaces a stale marker and ignores ordinary same-value events", async () => {
    localStorage.setItem(KEY, JSON.stringify(B));
    const fetcher = vi.fn(async () => response(user(A)));
    vi.stubGlobal("fetch", fetcher);
    const set = vi.spyOn(Storage.prototype, "setItem");
    mount();
    await waitFor(() => expect(session()).toBe(`authenticated:${A}:1`));
    expect(sync()).toBe("complete");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(A));
    expect(set).toHaveBeenCalledTimes(1);
    expect(Channel.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
    act(() => { Channel.instances[0]!.emit(); window.dispatchEvent(new Event("focus")); });
    expect(session()).toBe(`authenticated:${A}:1`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it.each([B, null])("does not install a late account or overwrite a new %s marker", async (next) => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    mount();
    notify(next);
    await act(async () => { pending.resolve(response(user(A))); await pending.promise; });
    await waitFor(() => expect(refresh()).toBe("true"));
    expect(session()).toBe("loading");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(next));
    expect(Channel.instances[0]!.postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("initialize"));
    fireEvent.click(screen.getByText("publish"));
    expect(session()).toBe("loading");
  });

  it("rechecks storage even when the change notification has not arrived", async () => {
    localStorage.setItem(KEY, JSON.stringify(A));
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetcher); mount();
    fireEvent.click(screen.getByText("initialize"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    localStorage.setItem(KEY, JSON.stringify(B));
    await act(async () => { pending.resolve(response(user(A))); await pending.promise; });
    await waitFor(() => expect(refresh()).toBe("true"));
    expect(session()).toBe("loading");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
    expect(Channel.instances[0]!.postMessage).not.toHaveBeenCalled();
  });

  it("accepts a server result matching a new observed marker and performs no duplicate publication", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    mount(); notify(B);
    const set = vi.spyOn(Storage.prototype, "setItem");
    await act(async () => { pending.resolve(response(user(B))); await pending.promise; });
    await waitFor(() => expect(session()).toBe(`authenticated:${B}:1`));
    expect(sync()).toBe("complete");
    expect(refresh()).toBe("false");
    expect(set).not.toHaveBeenCalled();
    expect(Channel.instances[0]!.postMessage).not.toHaveBeenCalled();
  });

  it("retains the confirmed user and sticky refresh after a different account and subsequent reversal", async () => {
    const fetcher = vi.fn(async () => response(user(A)));
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(sync()).toBe("complete"));
    notify(B); notify(A);
    fireEvent.click(screen.getByText("initialize")); fireEvent.click(screen.getByText("publish"));
    expect(refresh()).toBe("true");
    expect(session()).toBe(`authenticated:${A}:1`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a valid 401 as confirmed anonymous but a malformed response as an initialization error", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("broken", { status: 401 })).mockResolvedValueOnce(unauthorized());
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(session()).toBe("error"));
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.click(screen.getByText("initialize"));
    await waitFor(() => expect(session()).toBe("anonymous"));
    expect(localStorage.getItem(KEY)).toBe("null");
    expect(sync()).toBe("complete");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels the older generation and ignores its late response", async () => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetcher);
    render(<StrictMode><AccountSessionProvider><Consumer /></AccountSessionProvider></StrictMode>);
    const firstSignal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { second.resolve(response(user(B))); await second.promise; });
    await waitFor(() => expect(session()).toBe(`authenticated:${B}:1`));
    await act(async () => { first.resolve(response(user(A))); await first.promise; });
    expect(session()).toBe(`authenticated:${B}:1`);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
  });

  it("disposes the signal and aborts a pending initialization", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetcher); const view = mount();
    const requestSignal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    const channel = Channel.instances[0]!;
    view.unmount();
    expect(requestSignal.aborted).toBe(true);
    expect(channel.close).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(response(user(A))); await pending.promise; channel.emit(); });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(channel.postMessage).not.toHaveBeenCalled();
  });

  it("retains a confirmed user and retries a failed write without rereading identity", async () => {
    const failure = new Error("write failed");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw failure; });
    const fetcher = vi.fn(async () => response(user(A)));
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(sync()).toBe("write:false"));
    expect(session()).toBe(`authenticated:${A}:1`);
    expect(screen.getByTestId("cause")).toHaveTextContent("write failed");
    write.mockRestore();
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("complete");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(A));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a failed notification without writing or fetching again", async () => {
    const failure = new Error("channel unavailable"); Channel.openError = failure;
    const fetcher = vi.fn(async () => response(user(B)));
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(sync()).toBe("channel-open:true"));
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
    const set = vi.spyOn(Storage.prototype, "setItem");
    Channel.openError = undefined;
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("complete");
    expect(set).not.toHaveBeenCalled();
    expect(Channel.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries an observation read without republishing a completed identity", async () => {
    const fetcher = vi.fn(async () => response(user(A)));
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(sync()).toBe("complete"));
    const failure = new Error("observation failed");
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw failure; });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(sync()).toBe("read:false");
    expect(screen.getByTestId("cause")).toHaveTextContent("observation failed");
    expect(diagnostic).toHaveBeenCalledWith({ component: "account-sync", phase: "read", source: "foreground", category: "Error" });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("observation failed");
    get.mockRestore(); localStorage.removeItem(KEY);
    const set = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("complete");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(Channel.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves a pending send when its retry cannot read the record", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetcher); mount();
    const channel = Channel.instances[0]!;
    channel.postMessage.mockImplementationOnce(() => { throw new Error("send failed"); });
    await act(async () => { pending.resolve(response(user(B))); await pending.promise; });
    await waitFor(() => expect(sync()).toBe("channel-send:true"));
    expect(screen.getByTestId("cause")).toHaveTextContent("send failed");
    localStorage.removeItem(KEY);
    const set = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("read:true");
    expect(set).not.toHaveBeenCalled();
    localStorage.setItem(KEY, JSON.stringify(B));
    set.mockClear();
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("complete");
    expect(set).not.toHaveBeenCalled();
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never restores a superseded pending notification", async () => {
    Channel.openError = new Error("channel unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => response(user(B)))); mount();
    await waitFor(() => expect(sync()).toBe("channel-open:true"));
    localStorage.setItem(KEY, JSON.stringify(C));
    Channel.openError = undefined;
    fireEvent.click(screen.getByText("publish"));
    expect(refresh()).toBe("true");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(C));
    expect(Channel.instances).toHaveLength(0);
  });

  it("exposes invalid and unavailable records without inventing an identity or discarding a confirmed one", async () => {
    localStorage.setItem(KEY, '"invalid"');
    vi.stubGlobal("fetch", vi.fn(async () => response(user(A)))); mount();
    await waitFor(() => expect(session()).toBe(`authenticated:${A}:1`));
    expect(sync()).toBe("parse:false");
    localStorage.removeItem(KEY);
    const failure = new Error("read failed");
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw failure; });
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("read:false");
    expect(screen.getByTestId("cause")).toHaveTextContent("read failed");
    expect(diagnostic).toHaveBeenCalledWith({ component: "account-sync", phase: "read", source: "bootstrap", category: "Error" });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("read failed");
    expect(session()).toBe(`authenticated:${A}:1`);
    get.mockRestore();
    fireEvent.click(screen.getByText("publish"));
    expect(sync()).toBe("complete");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(A));
  });
  it("retains A and the network generation when an old 401 sees B before notification", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn((url: string) => url === "/api/v1/me" ? Promise.resolve(response(user(A))) : pending.promise);
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(session()).toBe(`authenticated:${A}:1`));
    const generation = readAuthRequestGeneration();
    const operation = request("/api/v1/projects", new AbortController().signal).catch(error => error);
    localStorage.setItem(KEY, JSON.stringify(B));
    await act(async () => { pending.resolve(unauthorized()); await operation; });
    expect(refresh()).toBe("true");
    expect(session()).toBe(`authenticated:${A}:1`);
    expect(readAuthRequestGeneration()).toBe(generation);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/me")).toHaveLength(1);
  });

  it("clears the current expired account and publishes null", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/v1/me" ? response(user(A)) : unauthorized())));
    mount(); await waitFor(() => expect(session()).toBe(`authenticated:${A}:1`));
    await act(async () => { await request("/api/v1/projects", new AbortController().signal); });
    expect(session()).toBe("anonymous");
    expect(refresh()).toBe("false");
    expect(localStorage.getItem(KEY)).toBe("null");
  });

  it("does not dispatch logout when a newer account is already recorded", async () => {
    const fetcher = vi.fn(async () => response(user(A)));
    vi.stubGlobal("fetch", fetcher); mount();
    await waitFor(() => expect(session()).toBe(`authenticated:${A}:1`));
    localStorage.setItem(KEY, JSON.stringify(B));
    fireEvent.click(screen.getByText("sign out"));
    expect(refresh()).toBe("true");
    expect(session()).toBe(`authenticated:${A}:1`);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(B));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

});
