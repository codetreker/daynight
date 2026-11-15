import { useEffect, useRef, useState, type ReactNode } from 'react';

export type CopyState = 'idle' | 'pending' | 'copied' | 'failed';

/** A result is associated with both this component instance and the copied value. */
export const CopyButton = ({ value, label, feedback }: {
  readonly value: string;
  readonly label: string;
  readonly feedback: (state: CopyState, event: string) => ReactNode;
}) => {
  const [result, setResult] = useState<{ value: string; state: CopyState }>({ value, state: 'idle' });
  const identity = useRef({ value, generation: 0 });
  if (identity.current.value !== value) identity.current = { value, generation: identity.current.generation + 1 };
  useEffect(() => () => { identity.current.generation++; }, []);
  const state = result.value === value ? result.state : 'idle';
  const copy = async () => {
    const request = ++identity.current.generation;
    setResult({ value, state: 'pending' });
    try {
      await navigator.clipboard.writeText(value);
      if (request === identity.current.generation && identity.current.value === value) setResult({ value, state: 'copied' });
    } catch {
      if (request === identity.current.generation && identity.current.value === value) setResult({ value, state: 'failed' });
    }
  };
  return <><button className="button task-detail-copy task-copy-button" type="button" aria-label={label} title={label} disabled={state === 'pending'} onClick={() => { void copy(); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>
  </button>{feedback(state, `${identity.current.generation}/${state}`)}</>;
};
