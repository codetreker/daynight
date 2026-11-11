import { useI18n } from "../../i18n/LocaleProvider";

export type SetupCopyProps = {
  readonly disabled: boolean;
  readonly copy: (text: string) => void;
};

export const SetupCommand = ({ text, title, disabled, copy }: SetupCopyProps & { readonly text: string; readonly title: string }) => {
  const { messages: { setup: m } } = useI18n();
  const label = m.copyLabel({ title });
  return <div className="setup-command"><pre><code>{text}</code></pre><button className="setup-copy" type="button" disabled={disabled} aria-label={label} title={label} onClick={() => copy(text)}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></svg>
  </button></div>;
};
