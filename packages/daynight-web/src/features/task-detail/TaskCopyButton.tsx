import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskDetailNotice } from './TaskDetailNotice';

export const TaskCopyButton = ({ value, label, failure }: {
  readonly value: string;
  readonly label: string;
  readonly failure: string;
}) => {
  const { messages: { inspection: { detail: m } } } = useI18n();
  const [state, setState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const copy = async () => {
    const request = ++generation.current;
    setState('pending');
    try {
      await navigator.clipboard.writeText(value);
      if (request === generation.current) setState('copied');
    } catch {
      if (request === generation.current) setState('failed');
    }
  };
  return <><button className="button task-detail-copy" type="button" aria-label={label} title={label} disabled={state === 'pending'} onClick={() => { void copy(); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>
    </button>
    <TaskDetailNotice active={state === 'copied' || state === 'failed'} event={`${generation.current}/${state}`} tone={state === 'failed' ? 'error' : 'success'}>
      {state === 'copied' && <span role="status">{m.copied}</span>}
      {state === 'failed' && <span role="alert">{failure}</span>}
    </TaskDetailNotice>
  </>;
};
