import { act, render } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { LocaleProvider, useLocalePreference } from "../../src/i18n/LocaleProvider";
import type { InitialLocale, Locale, LocaleStorage } from "../../src/i18n/locale";
import { TestTaskCacheBoundary, type TestTaskCacheOptions } from './taskCache';

type LocaleRenderOptions = Omit<RenderOptions, "wrapper"> & {
  readonly locale: Locale;
  readonly issue?: InitialLocale["issue"];
  readonly getStorage?: () => LocaleStorage;
  readonly taskCache?: boolean | TestTaskCacheOptions;
};

export const renderWithLocale = (ui: ReactElement, { locale, issue = null, getStorage, taskCache = false, ...options }: LocaleRenderOptions) => {
  let selectLocale!: (locale: Locale) => void;
  const Commands = () => { selectLocale = useLocalePreference().selectLocale; return null; };
  const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider initial={{ locale, issue }}
    {...(getStorage === undefined ? {} : { getStorage })}><Commands />{taskCache === false ? children : <TestTaskCacheBoundary {...(taskCache === true ? {} : taskCache)}>{children}</TestTaskCacheBoundary>}</LocaleProvider>;
  return { ...render(ui, { ...options, wrapper }), setLocale: (next: Locale) => act(() => selectLocale(next)) };
};

export const createLocaleRender = (locale: Locale) =>
  (ui: ReactElement, options: Omit<LocaleRenderOptions, "locale"> = {}) => renderWithLocale(ui, { ...options, locale });
