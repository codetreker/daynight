import { useI18n } from '../../i18n/LocaleProvider';
import { TaskCopyButton } from './TaskCopyButton';

export const TaskId = ({ value }: { readonly value: string }) => {
  const { messages: { inspection: { detail: m } } } = useI18n();
  return <><span>{value}</span><TaskCopyButton key={value} value={value} label={m.copyTaskId} failure={m.copyFailed} /></>;
};
