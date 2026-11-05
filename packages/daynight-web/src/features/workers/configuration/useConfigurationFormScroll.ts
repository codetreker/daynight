import { useLayoutEffect, useRef } from 'react';
import type { ConfigurationDraft } from './model';

// The document scrolls this form. Keep the active field and its error above the
// sticky actions without moving focus or changing the input's selection.
const revealFocusedField = (form: HTMLFormElement) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !form.contains(active)) return;
  const field = active.closest<HTMLElement>('.field');
  const bar = form.querySelector<HTMLElement>('.config-save-bar');
  if (field === null || bar === null) return;
  const barBox = bar.getBoundingClientRect();
  if (barBox.height === 0) return;
  const bottom = barBox.top - 12;
  const fieldBox = field.getBoundingClientRect();
  const box = fieldBox.height <= bottom ? fieldBox : active.getBoundingClientRect();
  if (box.bottom > bottom) window.scrollBy({ top: box.bottom - bottom, behavior: 'instant' });
  else if (box.top < 0) window.scrollBy({ top: box.top - 12, behavior: 'instant' });
};

export const useConfigurationFormScroll = (active: boolean, draft: ConfigurationDraft | null) => {
  const ref = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const form = ref.current;
    if (!active || form === null) return;
    const reveal = () => revealFocusedField(form);
    form.addEventListener('focusin', reveal);
    window.addEventListener('resize', reveal);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    const bar = form.querySelector('.config-save-bar');
    if (bar !== null) observer?.observe(bar);
    return () => { form.removeEventListener('focusin', reveal); window.removeEventListener('resize', reveal); observer?.disconnect(); };
  }, [active]);
  useLayoutEffect(() => {
    if (active && ref.current !== null) revealFocusedField(ref.current);
  }, [active, draft]);
  return ref;
};
