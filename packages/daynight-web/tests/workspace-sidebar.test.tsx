import { useRef } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsProvider } from "../src/features/projects/ProjectsProvider";
import { WorkspaceSidebar } from "../src/app/WorkspaceSidebar";
import { useBodyScrollLock } from "../src/app/useBodyScrollLock";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";

vi.mock("../src/features/teams/TeamSelector", () => ({ TeamSelector: () => null }));

const render = createLocaleRender("en");
type HarnessProps = {
  readonly collapsed?: boolean;
  readonly routeKey?: string;
  readonly identityChecking?: boolean;
  readonly initiallyInert?: boolean;
  readonly anotherLock?: boolean;
  readonly onToggle?: () => void;
  readonly onNavigate?: () => void;
};
const Harness = ({ collapsed = false, routeKey = "/", identityChecking = false, initiallyInert = false, anotherLock = false, onToggle = () => {}, onNavigate = () => {} }: HarnessProps) => {
  const workspace = useRef<HTMLDivElement>(null);
  useBodyScrollLock(anotherLock);
  return <ProjectsProvider>
    <WorkspaceSidebar collapsed={collapsed} onToggle={onToggle} routeKey={routeKey} projectsActive={routeKey === "/"} sharedActive={false} teamMembersActive={routeKey === "/members"} personalId="00000000-0000-4000-8000-000000000701" selectedTeamId="00000000-0000-4000-8000-000000000701" workersActive={routeKey === "/workers" || routeKey.startsWith("/workers/")} botsActive={routeKey === "/bots" || routeKey.startsWith("/bots/")} activeProjectId={null} identityChecking={identityChecking} workspaceRef={workspace} onNavigate={onNavigate} />
    <div ref={workspace} data-testid="workspace" inert={initiallyInert}><input aria-label="Retained draft" defaultValue="Unsubmitted" /></div>
  </ProjectsProvider>;
};

const openDrawer = () => {
  const toggle = screen.getByRole("button", { name: "Expand sidebar" });
  toggle.focus();
  fireEvent.click(toggle);
  return { toggle, drawer: screen.getByRole("dialog") };
};

describe("workspace sidebar", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {}))); });
  it("keeps icon navigation named and invokes only the desktop preference action", () => {
    const onToggle = vi.fn();
    render(<Harness collapsed onToggle={onToggle} />);
    expect(screen.queryByRole("link", { name: "Account settings" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "workspace-sidebar");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it.each(["/workers", "/workers/00000000-0000-4000-8000-000000000001"])("keeps Worker route %s active as a peer of project navigation", (routeKey) => {
    render(<Harness collapsed routeKey={routeKey} />);
    const workers = screen.getByRole("link", { name: "My Workers" });
    const projects = screen.getByRole("link", { name: "My projects" });
    expect(workers).toHaveAttribute("href", "/workers");
    expect(workers).toHaveAttribute("title", "My Workers");
    expect(workers).toHaveAttribute("aria-current", "page");
    expect(projects).not.toHaveAttribute("aria-current");
    expect(workers.parentElement).toBe(projects.parentElement);
    expect(workers.closest(".sidebar-projects")).toBeNull();
  });

  it.each(["/bots", "/bots/00000000-0000-4000-8000-000000000001"])("exposes assistant route %s outside project navigation", (routeKey) => {
    const view = render(<Harness collapsed routeKey={routeKey} />);
    const assistants = screen.getByRole("link", { name: "Assistants" });
    expect(assistants).toHaveAttribute("href", "/bots");
    expect(assistants).toHaveAttribute("aria-current", "page");
    expect(assistants.closest(".sidebar-projects")).toBeNull();
    expect(screen.getByRole("link", { name: "Test Sessions" })).toHaveAttribute("href", "/test-sessions");
    view.setLocale("zh-CN");
    expect(screen.getByRole("link", { name: /^助手$/ })).toBe(assistants);
  });

  it("opens assistants from the narrow drawer and preserves native modified navigation", () => {
    mockSidebarMediaQuery(true);
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    const { drawer } = openDrawer();
    const assistants = within(drawer).getByRole("link", { name: "Assistants" });
    fireEvent.click(assistants, { ctrlKey: true });
    expect(screen.getByRole("dialog")).toBe(drawer);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(assistants);
    expect(window.location.pathname).toBe("/bots");
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("provides a native Team members link and marks the active page", () => {
    render(<Harness collapsed routeKey="/members" />);
    const link = screen.getByRole("link", { name: "Team members" });
    expect(link).toHaveAttribute("href", "/teams/00000000-0000-4000-8000-000000000701/members");
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("retains native modified Worker navigation and closes the mobile drawer for ordinary navigation", () => {
    mockSidebarMediaQuery(true);
    const onNavigate = vi.fn();
    render(<Harness routeKey="/workers/00000000-0000-4000-8000-000000000001" onNavigate={onNavigate} />);
    const { drawer } = openDrawer();
    const workers = within(drawer).getByRole("link", { name: "My Workers" });
    fireEvent.click(workers, { ctrlKey: true });
    expect(screen.getByRole("dialog")).toBe(drawer);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(workers);
    expect(window.location.pathname).toBe("/workers");
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("updates accessible names in place when the interface language changes", () => {
    const view = render(<Harness collapsed />);
    const projects = screen.getByRole("link", { name: "My projects" });
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    view.setLocale("zh-CN");
    expect(screen.getByRole("link", { name: "我的项目" })).toBe(projects);
    expect(screen.queryByRole("link", { name: "账户设置" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("constrains keyboard and programmatic focus to the open mobile navigation and restores its opener", () => {
    mockSidebarMediaQuery(true);
    render(<Harness />);
    const background = screen.getByTestId("workspace");
    const draft = screen.getByRole("textbox", { name: "Retained draft" });
    const { toggle, drawer } = openDrawer();
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(background).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    const first = within(drawer).getByRole("link", { name: "Daynight project home" });
    expect(document.activeElement).toBe(first);
    const last = within(drawer).getByRole("button", { name: "Collapse sidebar" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    draft.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(background).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole("textbox", { name: "Retained draft" })).toBe(draft);
    expect(draft).toHaveValue("Unsubmitted");
  });

  it("closes on backdrop and the explicit toggle without changing desktop preference", () => {
    mockSidebarMediaQuery(true);
    const onToggle = vi.fn();
    render(<Harness collapsed onToggle={onToggle} />);
    const { toggle } = openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("keeps modified navigation native and ends the drawer on an ordinary same-route link", () => {
    mockSidebarMediaQuery(true);
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    const { drawer } = openDrawer();
    const projects = within(drawer).getByRole("link", { name: "My projects" });
    fireEvent.click(projects, { ctrlKey: true });
    expect(screen.getByRole("dialog")).toBe(drawer);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(projects);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("workspace")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it.each(["route", "identity"] as const)("ends mobile navigation on %s changes without retaining a hidden modal", (change) => {
    mockSidebarMediaQuery(true);
    const view = render(<Harness />);
    const draft = screen.getByRole("textbox");
    openDrawer();
    view.rerender(<Harness routeKey={change === "route" ? "/account" : "/"} identityChecking={change === "identity"} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("workspace")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(screen.getByRole("textbox")).toBe(draft);
    if (change === "identity") {
      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    view.rerender(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openDrawer();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("cleans media listeners and drawer state across breakpoints and unmount while preserving another scroll lock", () => {
    const media = mockSidebarMediaQuery(true);
    document.body.style.overflow = "auto";
    const view = render(<Harness collapsed anotherLock />);
    const draft = screen.getByRole("textbox");
    expect(media.listenerCount()).toBe(1);
    openDrawer();
    act(() => media.setNarrow(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("workspace")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("textbox")).toBe(draft);
    act(() => media.setNarrow(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    openDrawer();
    const background = screen.getByTestId("workspace");
    view.unmount();
    expect(background).not.toHaveAttribute("inert");
    expect(media.listenerCount()).toBe(0);
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });

  it("restores preexisting inert and scrolling state when the mobile layer closes", () => {
    mockSidebarMediaQuery(true);
    document.body.style.overflow = "scroll";
    const view = render(<Harness initiallyInert />);
    openDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("workspace")).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("scroll");
    view.unmount();
    document.body.style.overflow = "";
  });
});
