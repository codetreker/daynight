import { afterEach, describe, expect, it, vi } from "vitest";
import { invitationLocation, isLoginReturnPath, loginUrl, navigate, parseAuthRoute, parseLoginReturnPath, parseRoute, replaceRoute, taskDetailUrl } from "../src/app/router";

const taskId = "b0000000-0000-0000-0000-000000000002";
const projectId = "a0000000-0000-0000-0000-000000000001";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("route parsing", () => {
  it("maps the project list and canonicalizes decoded UUIDs", () => {
    expect(parseRoute("/projects")).toEqual({ kind: "projects" });
    expect(parseRoute("/")).toEqual({ kind: "notFound" });
    expect(parseRoute(`/projects/${projectId.toUpperCase()}`)).toEqual({ kind: "project", projectId });
    expect(parseRoute(`/projects/%61${projectId.slice(1)}`)).toEqual({ kind: "project", projectId });
  });

  it("parses complete attachment identities without normalizing filename case or literal percent escapes", () => {
    expect(parseRoute(`/projects/${projectId.toUpperCase()}/tasks/${taskId.toUpperCase()}/attachments/Docs/%E8%AE%BE%E8%AE%A1%20%3F%23%25.md`)).toEqual({ kind: "attachment", projectId, taskId, tab: "attachments", path: "Docs/设计 ?#%.md" });
    expect(parseRoute(`/projects/${projectId}/tasks/${taskId}/attachments/%252F`)).toEqual({ kind: "attachment", projectId, taskId, tab: "attachments", path: "%2F" });
  });

  it("parses task entries and explicit tabs while retaining a hidden file selection", () => {
    const task = `/projects/${projectId}/tasks/${taskId}`;
    expect(parseRoute(task)).toEqual({ kind: "task", projectId, taskId, tab: "overview", path: null });
    expect(parseRoute(task, "?tab=session")).toEqual({ kind: "task", projectId, taskId, tab: "session", path: null });
    expect(taskDetailUrl(projectId, taskId, { tab: "session", path: null })).toBe(`${task}?tab=session`);
    expect(parseRoute(task, "?tab=attachments")).toEqual({ kind: "task", projectId, taskId, tab: "attachments", path: null });
    expect(parseRoute(`${task}/attachments/docs/a.md`, "?tab=overview")).toEqual({ kind: "attachment", projectId, taskId, tab: "overview", path: "docs/a.md" });
    for (const search of ["?tab=", "?tab=invalid", "?tab=overview&tab=attachments", "?tab=%ZZ"]) expect(parseRoute(task, search)).toEqual({ kind: "notFound" });
    expect(taskDetailUrl(projectId, taskId, { tab: "overview", path: null })).toBe(task);
    expect(taskDetailUrl(projectId, taskId, { tab: "attachments", path: null })).toBe(`${task}?tab=attachments`);
    expect(taskDetailUrl(projectId, taskId, { tab: "overview", path: "设计 %2F #?.md" })).toBe(`${task}/attachments/%E8%AE%BE%E8%AE%A1%20%252F%20%23%3F.md?tab=overview`);
    expect(() => taskDetailUrl("bad", taskId, { tab: "overview", path: null })).toThrow();
  });

  it.each(["", "/", "a//b", "a/", "%2F", "a%2fb", "a%5Cb", ".", "..", "a/%2E%2E/b", "%00", "%7F", "C%3A/absolute", "%ED%A0%80", "%ZZ"])("rejects invalid attachment route path %s", (path) => {
    expect(parseRoute(`/projects/${projectId}/tasks/${taskId}/attachments/${path}`)).toEqual({ kind: "notFound" });
  });
  it("rejects invalid attachment route IDs", () => {
    expect(parseRoute(`/projects/bad/tasks/${taskId}/attachments/a.txt`)).toEqual({ kind: "notFound" });
    expect(parseRoute(`/projects/${projectId}/tasks/bad/attachments/a.txt`)).toEqual({ kind: "notFound" });
    expect(parseRoute(`/projects/%ZZ/tasks/${taskId}/attachments/a.txt`)).toEqual({ kind: "notFound" });
  });

  it.each([
    "", "/projects/", "/projects/not-a-uuid", `/projects/${projectId}/`, `/projects/${projectId}/tasks`,
    `/projects/${projectId.replaceAll("-", "")}`, "/projects/%ZZ", "/projects/%2F", "/unknown", "/%",
    `/projects/${projectId}?ignored=true`, `/projects/${projectId}#task`, "/projects/%ED%A0%80",
  ])("rejects unknown or invalid path %s", (pathname) => {
    expect(parseRoute(pathname)).toEqual({ kind: "notFound" });
  });
});

describe("navigation", () => {
  it("replaces intermediary authentication entries without adding a history loop", () => {
    const listener = vi.fn();
    window.addEventListener("popstate", listener);
    try {
      const length = window.history.length;
      replaceRoute("/login?returnPath=%2Fprojects");
      expect(window.history.length).toBe(length);
      expect(window.location.pathname).toBe("/login");
      expect(listener).toHaveBeenCalledOnce();
    } finally { window.removeEventListener("popstate", listener); }
  });
  it("pushes a same-origin entry and notifies route subscribers", () => {
    const subscriber = vi.fn();
    window.addEventListener("popstate", subscriber);
    try {
      const previousLength = window.history.length;
      navigate(`/projects/${projectId}`);
      expect(window.location.pathname).toBe(`/projects/${projectId}`);
      expect(window.history.length).toBe(previousLength + 1);
      expect(subscriber).toHaveBeenCalledOnce();
      expect(parseRoute(window.location.pathname)).toEqual({ kind: "project", projectId });
      navigate("/projects");
      expect(window.location.pathname).toBe("/projects");
      expect(subscriber).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("popstate", subscriber);
    }
  });

  it("supports native browser back and forward notifications", async () => {
    navigate(`/projects/${projectId}`);
    navigate("/projects");
    const move = (direction: "back" | "forward"): Promise<void> => new Promise((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history[direction]();
    });
    await move("back");
    expect(parseRoute(window.location.pathname)).toEqual({ kind: "project", projectId });
    await move("forward");
    expect(parseRoute(window.location.pathname)).toEqual({ kind: "projects" });
  });

  it("keeps the current page when history rejects cross-origin destinations", () => {
    expect(() => navigate("https://example.org/foreign")).toThrow();
    expect(window.location.pathname).toBe("/projects");
  });
});

describe("explicit login destinations", () => {
  it("uses a default only when the destination is absent and recognizes supported public and private routes", () => {
    expect(parseAuthRoute("/login")).toEqual({ kind: "login", returnPath: "/projects" });
    expect(parseLoginReturnPath("?returnPath=")).toBeNull();
    for (const path of ["/", "/?", "/setup", "/projects", "/projects?space=unencoded value", "/account", "/invitations", "/device?user_code=BCDFG-HJKLM", `/projects/${projectId}/members`, `/projects/${projectId}/settings`, `/projects/${projectId}/tasks/${taskId}/attachments/docs/a%20b.md?tab=overview`, `/projects/${projectId}/tasks/${taskId}/attachments/设计.md?tab=overview`]) {
      expect(isLoginReturnPath(path)).toBe(true);
      expect(parseLoginReturnPath(`?${new URLSearchParams({ returnPath: path })}`)).toBe(path);
      expect(new URL(loginUrl(path), window.location.origin).searchParams.get("returnPath")).toBe(path);
    }
    expect(parseAuthRoute(`/projects/${projectId}/settings`)).toEqual({ kind: "settings", projectId });
    expect(parseAuthRoute("/projects/bad/members")).toEqual({ kind: "notFound" });
  });

  it.each(["https://example.com/projects", "//example.com/projects", "/login", "/login?returnPath=%2Fprojects", "/login/extra", "/api/v1/me", "/auth/callback", "/unknown", "/projects/../login", "/projects#fragment", "/projects\n", "/projects%0A", "/projects?q=%5C", "/projects?q=%ZZ", "/\\example.com/projects"])("rejects supplied destination %j", (path) => {
    expect(isLoginReturnPath(path)).toBe(false);
    expect(parseLoginReturnPath(`?${new URLSearchParams({ returnPath: path })}`)).toBeNull();
    expect(() => loginUrl(path)).toThrow("supported same-origin page");
  });

  it("rejects duplicate destinations and retains the invitation lifetime only for its effective destination", () => {
    expect(parseLoginReturnPath("?returnPath=%2Fprojects&returnPath=%2Finvitations")).toBeNull();
    expect(invitationLocation("/invitations", "")).toBe(true);
    expect(invitationLocation("/login", "?returnPath=%2Finvitations&authError=login_failed")).toBe(true);
    expect(invitationLocation("/login", "?returnPath=%2Fprojects")).toBe(false);
    expect(invitationLocation("/login", "?returnPath=//elsewhere")).toBe(false);
    expect(invitationLocation("/projects", "?returnPath=%2Finvitations")).toBe(false);
  });
});
