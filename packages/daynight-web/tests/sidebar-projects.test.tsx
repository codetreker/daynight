import { useRef, type ReactNode } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../src/app/WorkspaceSidebar";
import type { Project } from "../src/api/types";
import { ProjectsProvider, useProjectList } from "../src/features/projects/ProjectsProvider";
import { ProjectsPage } from "../src/features/projects/ProjectsPage";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";
import { stringifyWireJson } from "./helpers/wireJson";

const render = createLocaleRender("en");
const project = (index: number, name = `Project ${index}`): Project => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name, repoUrl: `https://github.com/example/project-${index}`,
  settings: { version: 1n, executionWarningMinutes: 60 },
  createdAt: "2026-10-20T09:00:00Z", updatedAt: "2026-10-20T09:00:00Z",
});
const response = (items: readonly Project[], nextCursor: string | null = null) => new Response(stringifyWireJson({ items, nextCursor }), { headers: { "Content-Type": "application/json" } });
const failure = () => new Response(JSON.stringify({ error: { code: "internal_error", message: "private server detail", requestId: "rq-projects" } }), { status: 500, headers: { "Content-Type": "application/json" } });
const Harness = ({ activeProjectId = null, collapsed = false, onNavigate = () => {}, children }: { readonly activeProjectId?: string | null; readonly collapsed?: boolean; readonly onNavigate?: () => void; readonly children?: ReactNode }) => {
  const workspace = useRef<HTMLDivElement>(null);
  return <ProjectsProvider><WorkspaceSidebar collapsed={collapsed} onToggle={() => {}} routeKey={activeProjectId ?? "projects"} projectsActive={activeProjectId === null} activeProjectId={activeProjectId} accountActive={false} identityChecking={false} workspaceRef={workspace} onNavigate={onNavigate} /><div ref={workspace}>{children}</div></ProjectsProvider>;
};
const navigation = () => within(screen.getByRole("complementary", { name: "Workspace navigation" }));

describe("sidebar project navigation", () => {
  it("shares ordered pages and refresh with the project page without duplicate requests", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([project(2), project(1)], "next"))
      .mockResolvedValueOnce(response([project(1), project(3)]))
      .mockResolvedValueOnce(response([project(4)]));
    vi.stubGlobal("fetch", fetch);
    render(<Harness activeProjectId={project(1).id}><ProjectsPage /></Harness>);
    const nav = navigation();
    await nav.findByRole("link", { name: "Project 1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(nav.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Project 2", "Project 1"]);
    expect(nav.getByRole("link", { name: "Project 1" })).toHaveAttribute("aria-current", "true");
    expect(nav.getByRole("link", { name: "My projects" })).not.toHaveAttribute("aria-current");
    fireEvent.click(nav.getByRole("button", { name: "Load more" }));
    await screen.findByRole("heading", { name: "Project 3" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(nav.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Project 2", "Project 1", "Project 3"]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("heading", { name: "Project 4" });
    expect(nav.getByRole("link", { name: "Project 4" })).toBeInTheDocument();
    expect(nav.queryByRole("link", { name: "Project 1" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("exposes first-page errors and retries into an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(failure()).mockResolvedValueOnce(response([])));
    render(<Harness />);
    const nav = navigation();
    expect(await nav.findByRole("alert")).toHaveTextContent("Projects could not be loaded");
    expect(screen.queryByText("private server detail")).toBeNull();
    fireEvent.click(nav.getByRole("button", { name: "Retry" }));
    expect(await nav.findByText("No projects yet")).toBeInTheDocument();
    expect(nav.queryByRole("list")).toBeNull();
  });

  it("retains loaded links on a continuation error and retries the same cursor", async () => {
    const next = Promise.withResolvers<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response([project(1)], "more/+ page"))
      .mockReturnValueOnce(next.promise).mockResolvedValueOnce(response([project(2)]));
    vi.stubGlobal("fetch", fetch);
    render(<Harness />);
    const nav = navigation();
    await nav.findByRole("link", { name: "Project 1" });
    fireEvent.click(nav.getByRole("button", { name: "Load more" }));
    expect(nav.getByRole("button", { name: "Loading more…" })).toBeDisabled();
    await act(async () => next.resolve(failure()));
    expect(nav.getByRole("alert")).toHaveTextContent("Previously loaded projects remain available");
    expect(nav.getByRole("link", { name: "Project 1" })).toBeInTheDocument();
    fireEvent.click(nav.getByRole("button", { name: "Retry loading more" }));
    await nav.findByRole("link", { name: "Project 2" });
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v1/projects?limit=50&cursor=more%2F%2B+page");
    expect(fetch.mock.calls[2]?.[0]).toBe(fetch.mock.calls[1]?.[0]);
  });

  it("preserves full names and modified link behavior, then closes the mobile drawer on project navigation", async () => {
    mockSidebarMediaQuery(true);
    const name = "Infrastructure 跨团队协作 ".repeat(12).trim();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([project(1, name)])));
    const onNavigate = vi.fn();
    render(<Harness collapsed onNavigate={onNavigate} />);
    await act(async () => {});
    expect(navigation().queryByRole("link", { name })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const drawer = screen.getByRole("dialog");
    const link = within(drawer).getByRole("link", { name });
    expect(link).toHaveAttribute("title", name);
    expect(link).toHaveAttribute("href", `/projects/${project(1).id}`);
    fireEvent.click(link, { ctrlKey: true });
    expect(screen.getByRole("dialog")).toBe(drawer);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe(`/projects/${project(1).id}`);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("requires explicit ownership for project-list consumers", () => {
    const MissingProvider = () => { useProjectList(); return null; };
    expect(() => render(<MissingProvider />)).toThrow("Project browsing requires a ProjectsProvider.");
  });
});
