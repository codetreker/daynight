import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskDetailNotice } from './TaskDetailNotice';

export const TaskId = ({ value }: { readonly value: string }) => {
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
  return <><span>{value}</span><button className="button task-detail-copy" type="button" aria-label={m.copyTaskId} disabled={state === 'pending'} onClick={() => { void copy(); }}>{m.copy}</button>
    <TaskDetailNotice active={state === 'copied' || state === 'failed'} event={`${generation.current}/${state}`} tone={state === 'failed' ? 'error' : 'success'}>
      {state === 'copied' && <span role="status">{m.copied}</span>}
      {state === 'failed' && <span role="alert">{m.copyFailed}</span>}
    </TaskDetailNotice>
  </>;
};
