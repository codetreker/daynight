import { useI18n } from '../../i18n/LocaleProvider';
import { usageWords } from '../usage/UsageSummaryView';

export const ChainActionLabel = ({ label }: { readonly label: string }) => <span className="goal-detail-label">{label.split(/(\s+|[\p{Script=Han}])/u).filter(Boolean).map((part, index) => /^\s+$/u.test(part) ? part : <span className="goal-detail-word" data-label={part} key={index}><span>{part}</span></span>)}</span>;

export const ChainUsageButton = ({ id, title, onOpen }: { readonly id: string; readonly title: string; readonly onOpen: (id: string, trigger: HTMLElement) => void }) => {
  const { locale } = useI18n();
  const label = usageWords(locale === 'zh-CN').title;
  return <button className="goal-detail-link chain-usage-button" type="button" aria-haspopup="dialog" aria-label={`${title}${locale === 'zh-CN' ? '，' : ', '}${label}`} onClick={(event) => onOpen(id, event.currentTarget)}><ChainActionLabel label={label} /></button>;
};
