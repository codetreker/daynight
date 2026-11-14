import { useId, type ReactNode } from "react";
import { NativeSelect } from "../ui/native-select/NativeSelect";
import { useI18n, useLocalePreference } from "./LocaleProvider";
import { parseLocale, type LocaleIssue } from "./locale";
import "./language-selector.css";

export const LanguageSelector = ({ renderNotice }: { readonly renderNotice?: (notice: ReactNode, issue: LocaleIssue) => ReactNode }) => {
  const id = useId();
  const { locale, messages } = useI18n();
  const { issue, selectLocale, retrySave } = useLocalePreference();
  const noticeId = `${id}-notice`;

  const notice = issue === null ? null : <div id={renderNotice === undefined ? noticeId : undefined} className="locale-notice" role="status">
    <p>{messages.language.preferenceNotice[issue.kind]}</p>
    <button className="button" type="button" onClick={retrySave}>{messages.common.retrySave}</button>
  </div>;

  return <div className="locale-preference">
    <label className="locale-control" htmlFor={id}>
      <NativeSelect density="filter" id={id} aria-label={messages.language.label} value={locale} aria-describedby={issue === null ? undefined : noticeId}
        onChange={(event) => selectLocale(parseLocale(event.currentTarget.value))}>
        <option value="en">{messages.language.options.en}</option>
        <option value="zh-CN">{messages.language.options["zh-CN"]}</option>
      </NativeSelect>
    </label>
    {issue !== null && (renderNotice === undefined ? notice : <>
      <span id={noticeId} className="locale-notice-description">{messages.language.preferenceNotice[issue.kind]}</span>
      {renderNotice(notice, issue)}
    </>)}
  </div>;
};
