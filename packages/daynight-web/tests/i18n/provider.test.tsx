import { memo, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LanguageSelector } from "../../src/i18n/LanguageSelector";
import { LocaleProvider, useI18n, useLocaleCommands, useLocalePreference } from "../../src/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY, resolveInitialLocale } from "../../src/i18n/locale";
import type { LocaleIssue, LocaleStorage } from "../../src/i18n/locale";
import { renderWithLocale } from "../helpers/renderWithLocale";

const Fixture = () => {
  const { locale, messages } = useI18n();
  const [text, setText] = useState("User content / 用户内容");
  const [notice, setNotice] = useState<"write" | null>(null);
  return <>
    <LanguageSelector /><LanguageSelector /><LanguageSelector />
    <output aria-label="effective language">{locale}</output>
    <input aria-label="user content" value={text} onChange={(event) => setText(event.currentTarget.value)} />
    <button onClick={() => setNotice("write")}>Show semantic notice</button>
    {notice !== null && <p data-testid="semantic-notice">{messages.language.preferenceNotice[notice]}</p>}
  </>;
};

describe("language provider and selector", () => {
  it("shares three labeled selectors while preserving focus, input and semantic notification state", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { unmount } = renderWithLocale(<Fixture />, { locale: "en" });
    const selectors = screen.getAllByRole<HTMLSelectElement>("combobox", { name: "语言 / Language" });
    expect(new Set(selectors.map((selector) => selector.id)).size).toBe(3);
    selectors.forEach((selector) => {
      expect(selector).toHaveValue("en");
      expect(selector.closest("label")).not.toHaveTextContent("语言 / Language");
    });
    expect(write).not.toHaveBeenCalled();
    await user.tab();
    expect(selectors[0]).toHaveFocus();
    await user.tab();
    expect(selectors[1]).toHaveFocus();
    const input = screen.getByRole("textbox", { name: "user content" });
    await user.clear(input);
    await user.type(input, "Keep this input");
    await user.click(screen.getByRole("button", { name: "Show semantic notice" }));
    expect(screen.getByTestId("semantic-notice")).toHaveTextContent("The language could not be saved.");
    await user.selectOptions(selectors[1]!, "zh-CN");
    expect(screen.getAllByRole("combobox", { name: "语言 / Language" })).toEqual(selectors);
    expect(selectors[1]).toHaveFocus();
    selectors.forEach((selector) => expect(selector).toHaveValue("zh-CN"));
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("Keep this input");
    expect(screen.getByTestId("semantic-notice")).toHaveTextContent("语言无法保存到浏览器");
    expect(write).toHaveBeenCalledExactlyOnceWith(LOCALE_STORAGE_KEY, "zh-CN");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    unmount();
    const initial = resolveInitialLocale({ getStorage: () => window.localStorage, language: "en" });
    render(<LocaleProvider initial={initial}><Fixture /></LocaleProvider>);
    expect(screen.getByRole("status", { name: "effective language" })).toHaveTextContent("zh-CN");
    screen.getAllByRole("combobox").forEach((selector) => expect(selector).toHaveValue("zh-CN"));
  });

  it.each(["read", "invalid"] as const)("clears initial %s problems on save and preserves project preference records", async (kind) => {
    const user = userEvent.setup();
    const key = "daynight:project-view:project-id";
    const value = JSON.stringify({ expandedRootId: null });
    window.localStorage.setItem(key, value);
    renderWithLocale(<LanguageSelector />, { locale: "en", issue: { kind, cause: new Error("initial failure") } });
    expect(screen.getByRole("status")).toHaveTextContent(kind === "read" ? "could not be read" : "is invalid");
    await user.selectOptions(screen.getByRole("combobox"), "zh-CN");
    expect(screen.queryByRole("status")).toBeNull();
    expect(window.localStorage.getItem(key)).toBe(value);
    expect(resolveInitialLocale({ getStorage: () => window.localStorage, language: "en" })).toEqual({ locale: "zh-CN", issue: null });
  });

  it.each(["read", "invalid"] as const)("clears initial %s problems when retrying the current language succeeds", async (kind) => {
    const user = userEvent.setup();
    renderWithLocale(<LanguageSelector />, { locale: "zh-CN", issue: { kind, cause: "startup failure" } });
    await user.click(screen.getByRole("button", { name: "重试保存语言" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("keeps the chosen session language after write failure and retries the current selection from another selector", async () => {
    const user = userEvent.setup();
    const cause = new Error("quota exhausted");
    let failure = true;
    const storage: LocaleStorage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn((key, value) => { if (failure) throw cause; window.localStorage.setItem(key, value); }),
    };
    let currentIssue: LocaleIssue | null = null;
    const IssueObserver = () => { currentIssue = useLocalePreference().issue; return null; };
    renderWithLocale(<><Fixture /><IssueObserver /></>, { locale: "en", getStorage: () => storage });
    const selectors = screen.getAllByRole("combobox");
    await user.selectOptions(selectors[0]!, "zh-CN");
    expect(currentIssue).toEqual({ kind: "write", cause });
    expect(screen.getAllByText("语言无法保存到浏览器，本次选择已生效，刷新后可能无法恢复。")).toHaveLength(3);
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    selectors.forEach((selector) => expect(selector).toHaveValue("zh-CN"));
    await user.selectOptions(selectors[2]!, "en");
    expect(screen.getAllByText("The language could not be saved. Your choice applies now, but may not return after a reload.")).toHaveLength(3);
    failure = false;
    await user.click(screen.getAllByRole("button", { name: "Retry saving language" })[1]!);
    expect(screen.queryAllByText("The language could not be saved. Your choice applies now, but may not return after a reload.")).toHaveLength(0);
    expect(currentIssue).toBeNull();
    expect(storage.setItem).toHaveBeenLastCalledWith(LOCALE_STORAGE_KEY, "en");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("keeps presentation subscribers stable when only the preference issue changes", () => {
    const presentation = vi.fn();
    const commands = vi.fn();
    const Presentation = memo(() => { presentation(useI18n()); return null; });
    const Commands = memo(() => {
      const value = useLocaleCommands();
      commands(value);
      return <button onClick={value.retrySave}>Retry same locale</button>;
    });
    let fail = true;
    const getStorage = () => {
      if (fail) throw new Error("blocked storage access");
      return window.localStorage;
    };
    renderWithLocale(<><Presentation /><Commands /><LanguageSelector /></>, { locale: "en", getStorage });
    fireEvent.click(screen.getByRole("button", { name: "Retry same locale" }));
    expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
    expect(presentation).toHaveBeenCalledTimes(1);
    expect(commands).toHaveBeenCalledTimes(1);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry same locale" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(presentation).toHaveBeenCalledTimes(1);
    expect(commands).toHaveBeenCalledTimes(1);
  });

  it.each([
    [useI18n, "useI18n"], [useLocaleCommands, "useLocaleCommands"], [useLocalePreference, "useLocalePreference"],
  ] as const)("fails explicitly when %s has no provider", (hook, name) => {
    const MissingProvider = () => { hook(); return null; };
    expect(() => render(<MissingProvider />)).toThrow(`${name} requires a LocaleProvider.`);
  });
});
