import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../src/ui/copy-button/CopyButton';

describe('shared copy button', () => {
  it('renders a named decorative icon with native button semantics and forwards its ref and attributes', () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    const submit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={submit}><CopyButton ref={ref} label="Copy ID" onClick={onClick} data-testid="copy" /></form>);
    const button = screen.getByRole('button', { name: 'Copy ID' });
    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('title', 'Copy ID');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('retains visible text and the caller’s focusable aria-disabled semantics', () => {
    const onClick = vi.fn();
    render(<CopyButton label="Copy path" aria-disabled="true" onClick={onClick}>Copied</CopyButton>);
    const button = screen.getByRole('button', { name: 'Copy path' });
    expect(button).toHaveTextContent('Copied');
    expect(button).toHaveClass('copy-button--labelled');
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();
  });
});
