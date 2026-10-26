import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupGuidePage } from "../src/features/setup/SetupGuidePage";
import { renderWithLocale } from "./helpers/renderWithLocale";

const installCommand = "npm install --global @codetreker/daynight\ndaynight --version";
const projectCommand = 'daynight project create "项目名称"\ndaynight task list';
const example = "使用 using-daynight，为当前项目登记一个任务：补充安装说明。";
const clipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
};
const renderGuide = () => renderWithLocale(<SetupGuidePage />, { locale: "zh-CN" });

describe("daily setup guide", () => {
  it("presents five expanded steps and exact commands without requesting service data", () => {
    const fetcher = vi.fn(() => { throw new Error("The static guide must not fetch data"); });
    vi.stubGlobal("fetch", fetcher);
    renderGuide();
    const steps = within(screen.getByRole("list", { name: "使用步骤" })).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps.map((step) => within(step).getByRole("heading").textContent)).toEqual([
      "安装 Daynight CLI", "登录账户", "创建或找到仓库项目", "安装 Agent skill", "开始使用",
    ]);
    expect(steps.map((step) => step.querySelector("code")!.textContent)).toEqual([
      installCommand, "daynight login", projectCommand, "daynight skill install", example,
    ]);
    expect(screen.getByText(window.location.origin)).toBeVisible();
    expect(screen.getByText("Agent 请求")).toBeVisible();
    expect(screen.getByRole("link", { name: "返回项目列表" })).toHaveAttribute("href", "/projects");
    expect(screen.queryByText("daynight setup")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("copies the rendered multiline commands, quotes and Agent request verbatim", async () => {
    const writeText = clipboard();
    renderGuide();
    const buttons = screen.getAllByRole("button", { name: /^复制：/ });
    const commands = [installCommand, "daynight login", projectCommand, "daynight skill install", example];
    for (const [index, button] of buttons.entries()) {
      await act(async () => fireEvent.click(button));
      expect(writeText).toHaveBeenLastCalledWith(commands[index]);
      expect(screen.getByRole("status")).toHaveTextContent("已复制。");
    }
  });

  it("blocks repeat copies while pending and exposes clipboard denial with selectable source text", async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = clipboard(vi.fn(() => pending.promise));
    renderGuide();
    const buttons = screen.getAllByRole("button", { name: /^复制：/ });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("正在复制…");
    await act(async () => pending.reject(new DOMException("Denied", "NotAllowedError")));
    expect(screen.getByRole("status")).toHaveTextContent("请选中文字后手动复制");
    expect(buttons.every((button) => !button.hasAttribute("disabled"))).toBe(true);
    expect(document.querySelector(".setup-command code")!.textContent).toBe(installCommand);
    expect(screen.queryByText("Denied")).toBeNull();
  });

  it("offers manual copying when the browser does not provide the clipboard API", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    renderGuide();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制：登录账户" })));
    expect(screen.getByRole("status")).toHaveTextContent("浏览器无法复制这段文字");
    expect(screen.getByRole("button", { name: "复制：登录账户" })).not.toBeDisabled();
  });

  it.each(["resolve", "reject"] as const)("ignores a late %s from the previous language without repeating the copy", async (completion) => {
    const old = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    const writeText = clipboard(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
    const view = renderGuide();
    fireEvent.click(screen.getByRole("button", { name: "复制：创建或找到仓库项目" }));
    view.setLocale("en");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy: Create or find your repository project" }));
    expect(writeText).toHaveBeenLastCalledWith('daynight project create "Project name"\ndaynight task list');
    await act(async () => completion === "resolve" ? old.resolve() : old.reject(new Error("old failure")));
    expect(screen.getByRole("status")).toHaveTextContent("Copying…");
    expect(screen.getByRole("button", { name: "Copy: Sign in to your account" })).toBeDisabled();
    await act(async () => current.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Copied.");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("discards late clipboard results after leaving and reopening the page", async () => {
    const old = Promise.withResolvers<void>();
    const writeText = clipboard(vi.fn(() => old.promise));
    const first = renderGuide();
    fireEvent.click(screen.getByRole("button", { name: "复制：登录账户" }));
    first.unmount();
    renderGuide();
    await act(async () => old.resolve());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "复制：登录账户" })).not.toBeDisabled();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
