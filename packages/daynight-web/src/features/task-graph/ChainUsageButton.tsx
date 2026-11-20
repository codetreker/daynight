import { useI18n } from '../../i18n/LocaleProvider';
import { usageWords } from '../usage/UsageSummaryView';

export const ChainUsageButton = ({ id, title, onOpen }: { readonly id: string; readonly title: string; readonly onOpen: (id: string, trigger: HTMLElement) => void }) => {
  const { locale } = useI18n();
  const label = usageWords(locale === 'zh-CN').title;
  return <button className="goal-detail-link chain-usage-button" type="button" aria-haspopup="dialog" aria-label={`${title}${locale === 'zh-CN' ? '，' : ', '}${label}`} onClick={(event) => onOpen(id, event.currentTarget)}>{label}</button>;
};
