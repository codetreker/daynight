import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManagementDialog } from '../src/features/management/ManagementDialog';
import { NativeSelect } from '../src/ui/native-select/NativeSelect';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const subject = (onClose: () => void, busy = false) => <ManagementDialog title="Management" busy={busy} onClose={onClose}
  footer={<button type="button" disabled={busy}>Cancel</button>}>
  <label htmlFor="management-choice">Choice</label>
  <NativeSelect id="management-choice" defaultValue="draft" disabled={busy}><option value="draft">Draft</option><option value="other">Other</option></NativeSelect>
</ManagementDialog>;

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

describe('management dialog keyboard ownership', () => {
  it('leaves native popup Escape uncancelled and stops it before outer handlers', () => {
    const onClose = vi.fn(), outer = vi.fn();
    render(subject(onClose));
    const select = screen.getByRole('combobox');
    // JSDOM cannot open a system popup; the browser suite owns real cancellation.
    const originalMatches = select.matches.bind(select);
    let popupOpen = true;
    const matches = vi.spyOn(select, 'matches').mockImplementation((selector) => selector === ':open' ? popupOpen : originalMatches(selector));
    window.addEventListener('keydown', outer);
    try {
      const escape = key({ key: 'Escape' });
      fireEvent(select, escape);
      expect(matches).toHaveBeenCalledWith(':open');
      expect(escape.defaultPrevented).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      expect(outer).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeVisible();
      expect(select).toHaveValue('draft');
      popupOpen = false;
      const close = key({ key: 'Escape' });
      fireEvent(select, close);
      expect(close.defaultPrevented).toBe(true);
      expect(onClose).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('keydown', outer); }
  });

  it.each(['Escape', 'Tab'])('respects prevented and composing %s events', (pressed) => {
    const onClose = vi.fn(); render(subject(onClose));
    const select = screen.getByRole('combobox');
    const prevented = key({ key: pressed }); prevented.preventDefault();
    fireEvent(select, prevented);
    expect(select).toHaveFocus();
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = key({ key: pressed, ...init });
      fireEvent(select, event);
      expect(event.defaultPrevented).toBe(false);
      expect(select).toHaveFocus();
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps busy Escape from closing and uses current callbacks after rerender', () => {
    const onClose = vi.fn(), updated = vi.fn();
    const view = render(subject(onClose, true));
    const event = key({ key: 'Escape' }); fireEvent(document, event);
    expect(event.defaultPrevented).toBe(true); expect(onClose).not.toHaveBeenCalled();
    view.rerender(subject(updated)); fireEvent.keyDown(document, { key: 'Escape' });
    expect(updated).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
  });

  it('wraps Tab at both boundaries and restores the opener after unmount', () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    try {
      const view = render(subject(vi.fn()));
      const first = screen.getByRole('button', { name: 'Close dialog' }), last = screen.getByRole('button', { name: 'Cancel' });
      last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
      view.unmount(); expect(opener).toHaveFocus();
    } finally { opener.remove(); }
  });
});
