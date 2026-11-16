import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CopyButton } from './CopyButton';

export type CopyState = 'idle' | 'pending' | 'copied' | 'failed';

/** A result is associated with both this component instance and the copied value. */
export const ValueCopyButton = ({ value, label, feedback }: {
  readonly value: string;
  readonly label: string;
  readonly feedback: (state: CopyState, event: string) => ReactNode;
}) => {
  const [result, setResult] = useState<{ value: string; state: CopyState }>({ value, state: 'idle' });
  const identity = useRef({ value, generation: 0, pending: false });
  if (identity.current.value !== value) identity.current = { value, generation: identity.current.generation + 1, pending: false };
  useEffect(() => () => { identity.current.generation++; }, []);
  const state = result.value === value ? result.state : 'idle';
  const copy = async () => {
    if (identity.current.pending) return;
    identity.current.pending = true;
    const request = ++identity.current.generation;
    setResult({ value, state: 'pending' });
    try {
      await navigator.clipboard.writeText(value);
      if (request === identity.current.generation && identity.current.value === value) setResult({ value, state: 'copied' });
    } catch {
      if (request === identity.current.generation && identity.current.value === value) setResult({ value, state: 'failed' });
    } finally {
      if (request === identity.current.generation && identity.current.value === value) identity.current.pending = false;
    }
  };
  return <><CopyButton className="task-detail-copy task-copy-button" label={label} disabled={state === 'pending'} onClick={() => { void copy(); }} />
    {feedback(state, `${identity.current.generation}/${state}`)}</>;
};
