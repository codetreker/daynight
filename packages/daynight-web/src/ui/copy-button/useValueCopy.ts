import { useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'pending' | 'copied' | 'failed';

/** A result belongs to one value generation and one mounted instance. */
export const useValueCopy = (value: string) => {
  const identity = useRef({ value, generation: 0, request: 0, pending: false });
  if (identity.current.value !== value) identity.current = { value, generation: identity.current.generation + 1, request: identity.current.request, pending: false };
  useEffect(() => () => { identity.current.generation++; identity.current.pending = false; }, []);
  const [result, setResult] = useState<{ generation: number; state: CopyState; event: number }>({ generation: 0, state: 'idle', event: 0 });
  const state = result.generation === identity.current.generation ? result.state : 'idle';
  const copy = async () => {
    if (identity.current.pending) return;
    identity.current.pending = true;
    const generation = identity.current.generation;
    const request = ++identity.current.request;
    const current = () => identity.current.generation === generation && identity.current.request === request;
    setResult({ generation, state: 'pending', event: request });
    try {
      await navigator.clipboard.writeText(value);
      if (current()) setResult({ generation, state: 'copied', event: request });
    } catch {
      if (current()) setResult({ generation, state: 'failed', event: request });
    } finally {
      if (current()) identity.current.pending = false;
    }
  };
  return { state, event: `${result.event}/${state}`, copy };
};
