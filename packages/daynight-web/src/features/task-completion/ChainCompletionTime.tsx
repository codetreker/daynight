import { useI18n } from "../../i18n/LocaleProvider";
import { CompletionTimeLabel } from "./CompletionTimeLabel";
import { useChainCompletionHint } from "./useCompletionHint";
import type { CompletionValue } from "./useCompletionTime";

export const ChainCompletionTime = ({ value, title }: { readonly value: CompletionValue | null; readonly title: string }) => {
  const { messages: { completion } } = useI18n();
  const hint = useChainCompletionHint(value);
  if (value === null) return null;
  return <><button type="button" className="chain-completion-time" ref={hint.triggerRef} aria-label={completion.viewChain(title)} aria-describedby={hint.descriptionId} {...hint.triggerEvents} {...hint.labelEvents}>
    <CompletionTimeLabel value={value} />
  </button>{hint.hint}</>;
};
