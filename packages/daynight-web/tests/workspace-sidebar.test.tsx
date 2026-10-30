import { useRef } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsProvider } from "../src/features/projects/ProjectsProvider";
import { WorkspaceSidebar } from "../src/app/WorkspaceSidebar";
import { useBodyScrollLock } from "../src/app/useBodyScrollLock";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";

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
    <WorkspaceSidebar collapsed={collapsed} onToggle={onToggle} routeKey={routeKey} projectsActive={routeKey === "/"} workersActive={routeKey === "/workers" || routeKey.startsWith("/workers/")} activeProjectId={null} accountActive={routeKey === "/account"} identityChecking={identityChecking} workspaceRef={workspace} onNavigate={onNavigate} />
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
    const account = screen.getByRole("link", { name: "Account settings" });
    expect(account).toHaveAttribute("href", "/account");
    expect(account).toHaveAttribute("title", "Account settings");
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
    const account = screen.getByRole("link", { name: "Account settings" });
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    view.setLocale("zh-CN");
    expect(screen.getByRole("link", { name: "账户设置" })).toBe(account);
    expect(account).toHaveAttribute("title", "账户设置");
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
