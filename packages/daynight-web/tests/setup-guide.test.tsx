import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupGuidePage } from "../src/features/setup/SetupGuidePage";
import { mcpConfiguration } from "../src/features/setup/mcp-configuration";
import { renderWithLocale } from "./helpers/renderWithLocale";

const installCommand = "npm install --global @codetreker/daynight\ndaynight --version";
const projectCommand = 'daynight project create "项目名称"\ndaynight task list';
const example = "使用 using-daynight，为当前项目登记一个任务：补充安装说明。";
const clipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
};
const renderGuide = () => renderWithLocale(<SetupGuidePage />, { locale: "zh-CN" });

const codeBlock = (text: string) => {
  const code = screen.getByText((_, element) => element?.textContent === text, { selector: "code" });
  const block = code.closest(".setup-command");
  if (!(block instanceof HTMLElement)) throw new Error("Missing command block");
  return { code, button: within(block).getByRole("button") };
};

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
    expect(within(screen.getByRole("list", { name: "使用步骤" })).getByText("Agent 请求")).toBeVisible();
    expect(screen.getByRole("link", { name: "返回项目列表" })).toHaveAttribute("href", "/projects");
    expect(screen.queryByText("daynight setup")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("copies the rendered multiline commands, quotes and Agent request verbatim", async () => {
    const writeText = clipboard();
    renderGuide();
    const buttons = within(screen.getByRole("list", { name: "使用步骤" })).getAllByRole("button", { name: /^复制：/ });
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
    expect(codeBlock(installCommand).code).toBeVisible();
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

  it.each(["resolve", "reject"] as const)("discards a late clipboard %s after leaving and reopening the page", async (completion) => {
    const old = Promise.withResolvers<void>();
    const writeText = clipboard(vi.fn(() => old.promise));
    const first = renderGuide();
    fireEvent.click(screen.getByRole("button", { name: "复制：登录账户" }));
    first.unmount();
    renderGuide();
    await act(async () => completion === "resolve" ? old.resolve() : old.reject(new Error("old failure")));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "复制：登录账户" })).not.toBeDisabled();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe("MCP setup guide", () => {
  it.each([
    ["zh-CN", "客户端", "MCP 接入步骤", "通过 Daynight MCP 调用 team_list，列出我可访问的团队。"],
    ["en", "Client", "MCP setup steps", "Use Daynight MCP to call team_list and list the teams I can access."],
  ] as const)("shows and copies the exact three-client commands in %s", async (locale, clientLabel, stepsLabel, request) => {
    const writeText = clipboard();
    renderWithLocale(<SetupGuidePage />, { locale });
    const endpoint = new URL("/mcp", window.location.origin).href;
    const list = screen.getByRole("list", { name: stepsLabel });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText(/daynight:mcp/)).toBeVisible();
    expect(within(list).getByText(/team_list.*调用成功|read-only team_list call succeeds/i)).toBeVisible();
    const client = screen.getByRole("combobox", { name: clientLabel });
    expect(client).toHaveValue("codex");
    const cases = [
      { client: "codex", command: `codex mcp add daynight --url '${endpoint}'\ncodex mcp login daynight`, auth: "codex mcp login daynight --no-browser", doc: "https://developers.openai.com/codex/mcp/" },
      { client: "claude", command: `claude mcp add --transport http --scope user daynight '${endpoint}'\nclaude mcp login daynight`, auth: "claude mcp login daynight --no-browser", doc: "https://code.claude.com/docs/en/mcp" },
      { client: "copilot", command: `copilot mcp add --transport http daynight '${endpoint}'`, auth: "/mcp auth daynight", doc: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers" },
    ];
    for (const value of cases) {
      fireEvent.change(client, { target: { value: value.client } });
      expect(within(list).getByText(locale === "zh-CN"
        ? /在 POSIX shell 中运行命令.*Windows 用户请使用 Git Bash/
        : /run these commands in a POSIX shell \(on Windows, use Git Bash\)/)).toBeVisible();
      for (const text of [endpoint, value.command, value.auth, request]) {
        const { code, button } = codeBlock(text);
        expect(code).toBeVisible();
        await act(async () => fireEvent.click(button));
        expect(writeText).toHaveBeenLastCalledWith(text);
      }
      if (value.client === "copilot") {
        expect(within(list).getByText(locale === "zh-CN" ? "在 Copilot 会话中输入" : "Enter in your Copilot session")).toBeVisible();
      }
      expect(within(list).getByRole("link", { name: /官方文档|documentation/i })).toHaveAttribute("href", value.doc);
      expect(value.command).not.toContain("daynight login");
    }
    expect(screen.getByRole("link", { name: /安装手册|installation manual/i })).toHaveAttribute("href", "/mcp");
    expect(screen.getByRole("link", { name: /管理令牌|Manage tokens/i })).toHaveAttribute("href", "/account");
    expect(screen.getByText(/Authorization: Bearer <PAT>/)).toBeVisible();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shell-quotes endpoint arguments, including an embedded apostrophe", () => {
    const endpoint = "https://example.test/a'b";
    expect(mcpConfiguration("codex", endpoint).command).toBe("codex mcp add daynight --url 'https://example.test/a'\\''b'\ncodex mcp login daynight");
    expect(mcpConfiguration("claude", endpoint).command).toBe("claude mcp add --transport http --scope user daynight 'https://example.test/a'\\''b'\nclaude mcp login daynight");
    expect(mcpConfiguration("copilot", endpoint).command).toBe("copilot mcp add --transport http daynight 'https://example.test/a'\\''b'");
  });

  it.each(["resolve", "reject"] as const)("ignores a late %s after changing client while a new copy is pending", async (completion) => {
    const old = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    const writeText = clipboard(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
    renderGuide();
    fireEvent.click(codeBlock("codex mcp login daynight --no-browser").button);
    fireEvent.change(screen.getByRole("combobox", { name: "客户端" }), { target: { value: "claude" } });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(codeBlock("claude mcp login daynight --no-browser").button);
    await act(async () => completion === "resolve" ? old.resolve() : old.reject(new Error("old failure")));
    expect(screen.getByRole("status")).toHaveTextContent("正在复制");
    expect(screen.getAllByRole("button", { name: /^复制：/ }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(codeBlock("claude mcp login daynight --no-browser").button);
    expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("已复制");
  });

  it("retains the client across languages and resets it when reopened", () => {
    const view = renderGuide();
    const client = screen.getByRole("combobox", { name: "客户端" });
    fireEvent.change(client, { target: { value: "copilot" } });
    view.setLocale("en");
    expect(screen.getByRole("combobox", { name: "Client" })).toBe(client);
    expect(screen.getByRole("combobox", { name: "Client" })).toHaveValue("copilot");
    expect(codeBlock("/mcp auth daynight").code).toBeVisible();
    view.unmount();
    renderWithLocale(<SetupGuidePage />, { locale: "en" });
    expect(screen.getByRole("combobox", { name: "Client" })).toHaveValue("codex");
  });
});
