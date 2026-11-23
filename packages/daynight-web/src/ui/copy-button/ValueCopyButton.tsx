import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';
import { useValueCopy, type CopyState } from './useValueCopy';

export type { CopyState } from './useValueCopy';

export const ValueCopyButton = ({ value, label, feedback, copiedLabel, className = 'task-detail-copy task-copy-button', focusablePending = false }: {
  readonly value: string;
  readonly label: string;
  readonly feedback: (state: CopyState, event: string) => ReactNode;
  readonly copiedLabel?: string;
  readonly className?: string;
  readonly focusablePending?: boolean;
}) => {
  const { state, event, copy } = useValueCopy(value);
  return <><CopyButton className={className} label={label} disabled={!focusablePending && state === 'pending'}
    aria-disabled={focusablePending && state === 'pending' ? true : undefined} onClick={() => { void copy(); }}>
    {copiedLabel === undefined ? null : state === 'copied' ? copiedLabel : label}
  </CopyButton>{feedback(state, event)}</>;
};
