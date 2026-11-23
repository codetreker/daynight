import type { ComponentPropsWithRef } from 'react';
import './copy-button.css';

type Props = Omit<ComponentPropsWithRef<'button'>, 'type' | 'aria-label' | 'title' | 'onClick'> & {
  readonly label: string;
  readonly onClick: NonNullable<ComponentPropsWithRef<'button'>['onClick']>;
};

export const CopyButton = ({ label, children, className, ...props }: Props) =>
  <button {...props} type="button" aria-label={label} title={label}
    className={['copy-button', children != null && 'copy-button--labelled', className].filter(Boolean).join(' ')}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>
    {children}
  </button>;
