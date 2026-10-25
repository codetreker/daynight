import { useState } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSectionTabs, type ProjectSection } from "../src/features/projects/ProjectSectionTabs";
import { createLocaleRender } from "./helpers/renderWithLocale";

const render = createLocaleRender("zh-CN");
const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
const viewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  fireEvent(window, new Event("resize"));
};
const Tabs = ({ changed }: { readonly changed: (section: ProjectSection) => void }) => {
  const [section, setSection] = useState<ProjectSection>("overview");
  return <ProjectSectionTabs section={section} onChange={(value) => { setSection(value); changed(value); }} />;
};

beforeEach(() => { viewport(1024); });
afterEach(() => { Object.defineProperty(window, "innerWidth", originalWidth); });

describe("project section navigation", () => {
  it("uses vertical navigation keys on desktop and exposes stable panel relationships", () => {
    const changed = vi.fn();
    render(<Tabs changed={changed} />);
    const tabs = screen.getByRole("tablist", { name: "项目视图" });
    const overview = screen.getByRole("tab", { name: "概览" });
    const tasks = screen.getByRole("tab", { name: "任务列表" });
    expect(tabs).toHaveAttribute("aria-orientation", "vertical");
    expect(overview).toHaveAttribute("aria-controls", "project-section-panel-overview");
    expect(tasks).toHaveAttribute("aria-controls", "project-section-panel-tasks");
    expect(overview).toHaveAttribute("tabindex", "0");
    expect(tasks).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(overview, { key: "ArrowDown" });
    expect(tasks).toHaveAttribute("aria-selected", "true");
    expect(tasks).toHaveFocus();
    fireEvent.keyDown(tasks, { key: "ArrowDown" });
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: "ArrowUp" });
    expect(tasks).toHaveFocus();
    fireEvent.keyDown(tasks, { key: "Home" });
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: "End" });
    expect(tasks).toHaveFocus();
    fireEvent.click(overview);
    expect(overview).toHaveAttribute("aria-selected", "true");
  });

  it("switches horizontal keys with the responsive direction and releases its viewport listener", () => {
    viewport(390);
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const changed = vi.fn();
    const view = render(<Tabs changed={changed} />);
    const overview = screen.getByRole("tab", { name: "概览" });
    const tasks = screen.getByRole("tab", { name: "任务列表" });
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.keyDown(overview, { key: "ArrowDown" });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(tasks).toHaveFocus();
    fireEvent.keyDown(tasks, { key: "ArrowLeft" });
    expect(overview).toHaveFocus();
    viewport(741);
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    fireEvent.keyDown(overview, { key: "ArrowUp" });
    expect(tasks).toHaveFocus();
    const listener = added.mock.calls.find(([event]) => event === "resize")![1];
    view.unmount();
    expect(removed).toHaveBeenCalledWith("resize", listener);
  });

  it("uses the confirmed English names", () => {
    createLocaleRender("en")(<Tabs changed={vi.fn()} />);
    expect(screen.getByRole("tablist", { name: "Project views" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Task list" })).toHaveAttribute("aria-selected", "false");
  });
});
