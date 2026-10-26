import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LandingPage } from "../../src/features/landing/LandingPage";
import { en } from "../../src/i18n/messages/en";
import { zhCN } from "../../src/i18n/messages/zh-CN";
import { renderWithLocale } from "../helpers/renderWithLocale";

describe("landing page language changes", () => {
  it("keeps all demo choices and selector focus while translating the page and metadata without another identity read", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const interaction = userEvent.setup();
    const { container } = renderWithLocale(<LandingPage />, { locale: "en" });
    const tabs = screen.getAllByRole("tab");
    await interaction.click(container.querySelector<HTMLButtonElement>('[data-demo-task="ui"]')!);
    await interaction.click(tabs[0]!);
    await interaction.click(screen.getByRole("button", { name: en.landing.demo.documents.design.label }));
    await interaction.click(tabs[2]!);
    await interaction.click(screen.getByRole("button", { name: en.landing.demo.receiptLabels.handoff }));
    const selector = screen.getByRole("combobox", { name: "语言 / Language" });
    await interaction.selectOptions(selector, "zh-CN");
    expect(selector).toHaveFocus();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe(zhCN.landing.metadata.title);
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute("content", zhCN.landing.metadata.description);
    expect(document.querySelector('meta[property="og:title"]')).toHaveAttribute("content", zhCN.landing.metadata.title);
    expect(document.querySelector('meta[property="og:description"]')).toHaveAttribute("content", zhCN.landing.metadata.description);
    expect(document.querySelector('meta[property="og:type"]')).toHaveAttribute("content", "website");
    expect(document.querySelector('meta[property="og:site_name"]')).toHaveAttribute("content", "Daynight");
    expect(screen.getByRole("heading", { name: zhCN.landing.demo.receipts.handoff.title })).toBeVisible();
    expect(screen.getAllByRole("tab")[2]).toBe(tabs[2]);
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    await interaction.click(tabs[0]!);
    expect(screen.getByRole("button", { name: zhCN.landing.demo.documents.design.label })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: zhCN.landing.demo.documents.design.title })).toBeVisible();
    await interaction.click(tabs[1]!);
    expect(container.querySelector('[data-demo-task="ui"]')).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".task-detail")).toHaveTextContent(zhCN.landing.demo.readyNote);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("translates an identity error and blocked-task list without restarting the hint", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Controlled network error"));
    vi.stubGlobal("fetch", fetcher);
    const { container, setLocale } = renderWithLocale(<LandingPage />, { locale: "en" });
    const notice = await screen.findByRole("status");
    const interaction = userEvent.setup();
    await interaction.click(container.querySelector<HTMLButtonElement>('[data-demo-task="verification"]')!);
    setLocale("zh-CN");
    expect(screen.getByRole("status")).toBe(notice);
    expect(notice).toHaveTextContent(zhCN.landing.navigation.identityFailed);
    expect(container.querySelector(".task-detail")).toHaveTextContent(zhCN.landing.demo.blockedNote({ tasks: new Intl.ListFormat("zh-CN").format([zhCN.landing.demo.tasks.api.title, zhCN.landing.demo.tasks.ui.title, zhCN.landing.demo.tasks.email.title]) }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });
});
