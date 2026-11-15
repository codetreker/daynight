import { useI18n } from '../../i18n/LocaleProvider';
import { CopyButton } from '../task-row/CopyButton';
import { TaskDetailNotice } from './TaskDetailNotice';

export const TaskCopyButton = ({ value, label, failure }: {
  readonly value: string;
  readonly label: string;
  readonly failure: string;
}) => {
  const { messages: { inspection: { detail: m } } } = useI18n();
  return <CopyButton value={value} label={label} feedback={(state, event) =>
    <TaskDetailNotice active={state === 'copied' || state === 'failed'} event={event} tone={state === 'failed' ? 'error' : 'success'}>
      {state === 'copied' && <span role="status">{m.copied}</span>}
      {state === 'failed' && <span role="alert">{failure}</span>}
    </TaskDetailNotice>} />;
};
