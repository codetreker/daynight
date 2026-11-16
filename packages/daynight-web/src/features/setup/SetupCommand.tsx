import { useI18n } from "../../i18n/LocaleProvider";
import { CopyButton } from "../../ui/copy-button/CopyButton";

export type SetupCopyProps = {
  readonly disabled: boolean;
  readonly copy: (text: string) => void;
};

export const SetupCommand = ({ text, title, disabled, copy }: SetupCopyProps & { readonly text: string; readonly title: string }) => {
  const { messages: { setup: m } } = useI18n();
  const label = m.copyLabel({ title });
  return <div className="setup-command"><pre><code>{text}</code></pre><CopyButton className="setup-copy" disabled={disabled} label={label} onClick={() => copy(text)} /></div>;
};
